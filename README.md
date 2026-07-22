# Mindgrove Media Manager

Self-hosted dashboard for uploading files behind **stable short URLs**, backed by your choice
of local disk, Bunny CDN, or any S3-compatible storage. Link a short URL anywhere once — swap
the file behind it forever, the URL never changes.

---

## Quick start

```bash
cp .env.example .env        # then edit secrets (see below)
npm install
npm start                   # http://localhost:3000
```

First run seeds an admin from `.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). Log in, then
create users and taxonomy. Optional sample taxonomy:

```bash
npm run seed                # adds Home → Hero → {Desktop, Mobile}
npm run dev                 # auto-restart on file changes
```

Runs on the **local** storage driver out of the box (files in `data/uploads/`), so no Bunny
setup is needed to try it.

---

## Everyday use

1. **Log in** (`/login`).
2. Pick **Page → Section → Variant** (cascading dropdowns).
3. **Upload** a file → get a short link `https://<host>/f/<slug>`. Leave slug blank for an
   auto-code, or set a custom one.
4. Per file card: **Copy** link · **Replace file** (overwrite the bytes, same link) ·
   **Edit link** (change slug — the old slug keeps working, forwarding to the new one) ·
   **Remove** (click twice to confirm).

**Roles**
- **user** — select existing taxonomy, upload / replace / remove / edit-link files.
- **admin** — all of the above + **Users** (`/admin/users`) + **Taxonomy CRUD**
  (`/admin/taxonomy`) + **Settings** (`/admin/settings`) + **Database** (`/admin/database`).

**Database browser** (`/admin/database`, admin only) is a phpMyAdmin-style direct table
editor: browse any table, click a cell to edit it inline, add/delete rows, or run raw SQL.
It bypasses all app logic — deleting a `links` row here won't remove its stored file, and
nothing is validated. It's a power tool for fixing data by hand, not a normal workflow.

**Storage location** is chosen in **Settings** (admin): **Local folder** or **Bunny CDN**.
Switching affects only *new* uploads — each existing file keeps serving from wherever it was
stored. The `.env` `STORAGE_DRIVER` is just the initial default.

---

## Configuration (`.env`)

| Key | Meaning |
|---|---|
| `PORT` | listen port (default 3000) |
| `BASE_URL` | public URL, used to build short links. `https://…` also flips secure cookies on |
| `SESSION_SECRET` | **set a long random value in production** |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | seed admin (first run only) |
| `MAX_FILE_MB` | max upload size (default 100) |
| `STORAGE_DRIVER` | `local` (dev) or `bunny` |
| `BUNNY_STORAGE_ZONE` | Bunny storage zone name (`corevoice`) |
| `BUNNY_STORAGE_ACCESS_KEY` | storage-zone password/access key |
| `BUNNY_STORAGE_HOST` | region host (default `storage.bunnycdn.com`) |
| `BUNNY_PULL_ZONE_HOST` | **required for CDN downloads** — e.g. `corevoice.b-cdn.net`. Empty = proxy mode |
| `BUNNY_BASE_PATH` | prefix folder inside the zone (`mindgrove`) so uploads don't collide |
| `BUNNY_API_KEY` | optional, for CDN cache purge |

### Configuring storage (in-app)

Go to **Settings** (`/admin/settings`, admin only). Pick a driver — selecting **Bunny CDN** or
**S3-compatible** reveals its connection fields to paste creds into:

- **Bunny CDN** — storage zone, access key, storage host, **pull-zone host** (public CDN), base path.
- **S3-compatible** — endpoint (blank for AWS), region, bucket, access key ID, secret,
  **public base URL** (CDN/custom domain), key prefix, force-path-style (MinIO). Works with
  AWS S3, Bunny's S3 gateway, Cloudflare R2, Backblaze B2, MinIO.

Secrets are **encrypted at rest** (AES-256-GCM, key from `APP_SECRET`/`SESSION_SECRET`) and are
never sent back to the browser — blank a secret field to keep the existing value. Values entered
here **override** the matching `.env` keys. You can still pre-seed everything via `.env`
(`BUNNY_*`, `S3_*`, `STORAGE_DRIVER`) for headless/first-boot setup.

> **Public downloads:** if no pull-zone (Bunny) / public base URL (S3) is set, `/f/:slug` falls
> back to **proxy mode** — the app streams the bytes itself (works, but no CDN).

> ⚠️ Storage access keys grant full read/write/delete. Never commit them; rotate if leaked.

---

## Deploy

Needs a persistent disk for `data/` (SQLite + sessions + local uploads).

### Docker Compose (recommended)

```bash
cp .env.example .env        # edit secrets — see Configuration below
docker compose up -d --build
docker compose logs -f      # watch it boot
```

That's it — `docker-compose.yml` builds the image, maps `${PORT:-3000}`, loads `.env`, and
mounts a named volume (`data`) at `/app/data` so the database and uploads survive restarts
and rebuilds. To stop: `docker compose down` (add `-v` only if you actually want to wipe the
volume/data).

One volume is enough here — app *code* lives in the image (rebuilt fresh each deploy),
`/app/data` is the only thing that persists, so updating the app never touches stored data.
(This isn't like a Postgres-backed app such as n8n, which needs a second volume because it
runs a *separate database container* — this app's SQLite db is embedded in the same process.)

`data/uploads/` is also committed to git (see `.gitignore`) as a lightweight backup of what's
on local-disk storage. Worth knowing: git isn't a real backup system for growing binary
files — history only grows, GitHub hard-blocks any file over 100MB, and there's no dedup. Fine
for small internal use; for real volume, snapshot the Docker volume or rely on the CDN instead.

### Plain Docker

```bash
docker build -t mindgrove-media-manager .
docker run -d -p 3000:3000 --env-file .env -v mindgrove_data:/app/data mindgrove-media-manager
```

### Any host with Node 22+

```bash
npm ci --omit=dev
npm start
```

Whichever route: set `BASE_URL` to the public app domain and use a real `SESSION_SECRET`. The
short link is served by the **app** domain — the app must be running to resolve `/f/:slug`
(it either 302-redirects to a CDN or streams the bytes itself, depending on the active driver).

---

## How it works

```
Browser ──upload──► App (Express) ──stream PUT──► Bunny Storage ──pull zone──► Bunny CDN
                      │  SQLite (source of truth)
GET /f/:slug ─────────┘  → look up current version → 302 redirect to CDN url
```

- **Stable link, swappable file.** A `link` owns a slug and holds one current file. Replacing
  uploads the new bytes (to a fresh storage key), repoints the link, and deletes the old bytes
  — the slug is untouched. No version history.
- **Renaming never breaks a handed-out link.** Changing a slug records the old one in a
  `redirects` table; `/f/:old-slug` 301-forwards to the current slug, chained across any
  number of renames. A slug reserved as someone's redirect can't be reused elsewhere.
- **Streaming upload.** Files stream from a temp file straight into storage (constant memory).
  Bunny/S3 get a SHA-256 checksum for integrity; the **local** driver skips hashing and all
  config resolution — no wasted work when you're not using a remote backend.
- **Per-file driver.** Each link records whether it lives on `local`, `bunny`, or `s3`, so
  downloads resolve correctly even after an admin switches the active storage location.
- **Taxonomy tree.** `page → section → variant`; many files per slot, each its own short link.

### Layout

```
server.js         Express bootstrap, page routes, middleware
db.js             SQLite schema (better-sqlite3)
auth.js           sessions, login, seed admin, role middleware
storage.js        local/Bunny/S3 storage adapter (stream, checksum, delete, proxy)
storageConfig.js  resolves active storage config (DB settings override .env), secret handling
crypto.js         AES-256-GCM helper for encrypting stored credentials at rest
settings.js       key/value app settings; active storage driver
slug.js           slug generate/validate
routes/
  api.js          taxonomy + files (upload/replace/slug/delete)
  admin.js        user management + storage settings
  dbadmin.js      phpMyAdmin-style table browser/editor (admin only)
  shorturl.js     GET /f/:slug redirect
views/            EJS pages (login, dashboard, admin-users/-taxonomy/-settings/-database)
public/           style.css + client JS (app.js, admin-*.js)
scripts/seed.js   optional sample taxonomy
data/             SQLite db (gitignored) + uploads/ (tracked in git for backup)
docker-compose.yml / Dockerfile / .dockerignore   container build + run
```

Full design rationale and decisions: [PLAN.md](PLAN.md).
