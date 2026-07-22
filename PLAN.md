# Mindgrove File Upload Platform — Build Plan

A self-hosted dashboard for uploading files to Bunny CDN behind **stable short URLs**.
The short URL never changes; the file it points to can be replaced any time. Link it
anywhere once, swap the file forever.

---

## 1. Goals

1. Credential auth with two roles: **user** and **admin**.
2. SQLite file database (single-file, portable, no external DB server).
3. File-upload platform — upload happens **through the dashboard**, server pushes to Bunny.
4. Built-in **URL shortener** so a file can be swapped without changing the public URL.

---

## 2. Confirmed decisions

| Topic | Decision |
|---|---|
| Stack | Node + Express + SQLite (`better-sqlite3`), server-rendered EJS + vanilla JS |
| File storage | Bunny Storage + Bunny CDN pull zone; local-disk fallback for dev |
| Upload path | Browser → dashboard (multipart) → server → Bunny Storage API. User never touches Bunny. |
| Taxonomy | **page → section → variant**, cascading tree |
| Taxonomy editing | **Admin only** — full CRUD (create/rename/delete). Users select from existing dropdowns only, no inline add. |
| Files per slot | **Many** per (page, section, variant) — each file is its own card + own short link |
| Card identity | Labeled by uploaded **filename** (auto) |
| Slug style | Auto-generated 8-char by default, **editable** to a custom readable slug |
| Versioning | Every upload/replace = new version row; old versions kept (rollback + history) |
| Short URL | `/f/:slug` → **302 redirect** to the current version's CDN url |

---

## 3. Architecture

```
        ┌─────────────────────────────────────────────────────────┐
        │  Browser (dashboard, session cookie)                      │
        └───────────────┬───────────────────────────┬──────────────┘
                        │ multipart upload           │ JSON (taxonomy, cards)
                        ▼                             ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Node / Express app                                       │
        │   • auth + sessions (connect-sqlite3)                     │
        │   • taxonomy + links + versions  ── SQLite (app.sqlite)   │  ← source of truth
        │   • storage adapter ──────────────┐                       │
        │   • GET /f/:slug  → 302 redirect  │                       │
        └───────────────────────────────────┼───────────────────────┘
                                             ▼  PUT (Storage API)
                                    ┌──────────────────┐
                                    │  Bunny Storage    │
                                    └─────────┬─────────┘
                                              │ pull zone
                                              ▼
                                    ┌──────────────────┐   public file bytes
                                    │  Bunny CDN        │ ─────────────────────►  end users
                                    └──────────────────┘
```

**Why app + CDN are separate:** SQLite, sessions, and auth need a running process with a
persistent disk. A CDN cannot run that. So the app runs on a small box/container; only the
file bytes live on Bunny. The short URL is the indirection layer between them.

**Redirect flow:** `GET /f/abc123` → look up link by slug → its `current_version` →
`302 Location: https://<pull-zone>/<path>`. Swap the file → new version → repoint
`current_version` → **same slug now serves the new bytes**.

---

## 4. Data model (SQLite)

```
users
  id, username (unique), password_hash (bcrypt), role ['user'|'admin'],
  active (0/1), created_at

pages
  id, name (unique), created_by, created_at

sections
  id, page_id → pages, name, created_at, created_by
  UNIQUE (page_id, name)

variants
  id, section_id → sections, name, created_at, created_by
  UNIQUE (section_id, name)

links                       -- one per FILE (many per page/section/variant slot)
  id, slug (unique),
  page_id, section_id, variant_id,
  label,                    -- display name, seeded from filename
  current_version_id → versions,
  created_by, created_at

versions                    -- immutable history, newest = current
  id, link_id → links,
  version_no,               -- 1,2,3… per link
  storage_path,             -- key in Bunny/local, e.g. abc123/v2-guide.pdf
  cdn_url,                  -- full public url (or /files/... in dev)
  driver,                   -- 'bunny' | 'local'
  original_name, mime, size,
  uploaded_by, created_at
```

Cascade: delete page → its sections → variants → links → versions.
Storage bytes deleted best-effort alongside link/version removal.

---

## 5. User flow

1. **Login splash** — username + password. No self-signup; admin creates accounts.
2. **Dashboard** — three cascading dropdowns:
   - pick **page** → sections load
   - pick **section** → variants load
   - pick **variant** → file cards + upload zone appear
   - dropdowns are **select-only for users** (no inline add). If a page/section/variant is
     missing, a user must ask an admin to create it. (Admins get add/edit/delete — see below.)
3. **Slot view** — cards for every file in that page/section/variant:
   - filename + icon, size, last updated
   - **short URL** with copy button
   - **Replace** — pick a new file → new version, slug unchanged
   - **Remove** — delete the file + its short link (confirm)
   - **Edit shortlink** — change the slug (with a warning that existing published links break)
   - **History** — list versions, optional rollback to an older one
4. **Upload zone** — drop/select a file → creates a new card + new short link, returns the URL.

**Admin extras:**
- **Users** — create, deactivate, reset password, set role.
- **Taxonomy CRUD** — a dedicated admin screen to create / rename / delete pages, sections,
  and variants (the dropdown options). Delete cascades (see §4) with a warning.
- View all links across all users.

---

## 6. Routes & API

### Pages (server-rendered)
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/login` | public | login splash |
| POST | `/login` | public | authenticate, start session |
| POST | `/logout` | auth | end session |
| GET | `/` | user | dashboard (picker + cards) |
| GET | `/admin` | admin | admin home |
| GET | `/admin/users` | admin | user management |
| GET | `/admin/taxonomy` | admin | page/section/variant CRUD |

### JSON API (session-guarded)

**Taxonomy reads — any authenticated user** (populate dropdowns):
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/pages` | list pages |
| GET | `/api/pages/:id/sections` | sections under a page |
| GET | `/api/sections/:id/variants` | variants under a section |
| GET | `/api/variants/:id/files` | file cards for a slot |

**Taxonomy writes — ADMIN ONLY** (full CRUD):
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/pages` | create page `{name}` |
| PATCH | `/api/pages/:id` | rename page `{name}` |
| DELETE | `/api/pages/:id` | delete page (cascades) |
| POST | `/api/sections` | create section `{page_id, name}` |
| PATCH | `/api/sections/:id` | rename section `{name}` |
| DELETE | `/api/sections/:id` | delete section (cascades) |
| POST | `/api/variants` | create variant `{section_id, name}` |
| PATCH | `/api/variants/:id` | rename variant `{name}` |
| DELETE | `/api/variants/:id` | delete variant (cascades) |
| POST | `/api/upload` | multipart `{variant_id, file, slug?}` → new link + v1 |
| POST | `/api/links/:id/replace` | multipart `{file}` → new version |
| PATCH | `/api/links/:id/slug` | `{slug}` change short link |
| DELETE | `/api/links/:id` | remove file + short link |
| GET | `/api/links/:id/versions` | version history |
| POST | `/api/links/:id/rollback` | `{version_id}` set current to older version |
| POST | `/api/admin/users` | admin: create user |
| PATCH | `/api/admin/users/:id` | admin: activate/deactivate / reset pw / role |

### Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/f/:slug` | 302 redirect to current CDN url |
| GET | `/files/*` | serve local files (dev fallback only) |

---

## 7. Storage adapter

- `STORAGE_DRIVER=local` (dev): writes to `data/uploads/<key>`, serves via `/files/<key>`.
- `STORAGE_DRIVER=bunny` (prod): `PUT https://<host>/<zone>/<key>` with `AccessKey` header;
  public url = `https://<pull-zone>/<key>`.
- **Key scheme:** `<slug>/v<n>-<sanitized-filename>` — versioned, so replacing never
  overwrites old bytes (clean rollback, no CDN cache staleness).
- Optional CDN **purge** hook on Bunny (account API key) — not needed with versioned keys,
  included for completeness.

Config via `.env` (see `.env.example`). App runs immediately on `local` with zero Bunny
setup; flip to `bunny` once keys are in.

### Upload path — DECIDED: A, server-proxy with streaming

Using the `corevoice` storage zone + native Storage HTTP API (the key provided).

- **Upload:** `PUT https://storage.bunnycdn.com/corevoice/<base>/<key>`
  headers `AccessKey`, `Content-Type: application/octet-stream`, `Content-Length`,
  and `Checksum` (uppercase SHA-256 hex — Bunny verifies + rejects on mismatch).
- **Efficiency:** the app **streams** the multipart file part straight into the PUT body
  (busboy → streaming `fetch`), so memory stays O(1) regardless of file size — no full buffer.
- **No resumable/multipart** in the native API (S3-API only). Single PUT; acceptable for a
  link dashboard. If multi-GB resumable uploads become a need later, switch that route to the
  S3 API + presigned/multipart (adapter is isolated so it's a localized change).
- **Key scheme:** `<BUNNY_BASE_PATH>/<slug>/v<n>-<sanitized-filename>` — namespaced under a
  prefix so we don't collide with other content in the shared zone; versioned so replace never
  overwrites old bytes.

### Public download path — OPEN (§9 #9)

Storage GETs require the `AccessKey` — the storage endpoint is **not public**. So the short
URL needs one of:
- **(a) Pull Zone (recommended):** attach a pull zone to `corevoice`; public url becomes
  `https://<pull-zone>/<key>`. `/f/:slug` → 302 redirect there → CDN-cached, fast.
- **(b) Proxy mode (fallback):** `/f/:slug` does an authenticated GET to storage and streams
  the bytes through the app. No pull zone needed, but the app bears all download bandwidth on
  every request — not CDN-cached. Only sensible for low-traffic files.

Adapter reads `BUNNY_PULL_ZONE_HOST`: set → mode (a); empty → mode (b).

---

## 8. Auth & security

- Passwords hashed with **bcrypt**. No plaintext ever stored or logged.
- Sessions in a **SQLite-backed store** (`connect-sqlite3`), `httpOnly` + `sameSite=lax`
  cookies; `secure` when `BASE_URL` is https.
- **helmet** for security headers.
- Login **rate limiting** (in-memory) to slow brute force.
- Role gate middleware: `requireAuth`, `requireAdmin`.
- Server-side validation on slug (`^[a-z0-9][a-z0-9-]{2,63}$`), file size, and field types.
- Seed admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` on first run only (when users table empty).

**Roles:**
- **user** — select existing page/section/variant, upload / replace / remove / edit-slug files.
  Cannot create or edit taxonomy.
- **admin** — everything a user can do, plus user management and full taxonomy CRUD.

**Open item (need your call):** who can Replace / Remove / Edit-slug a file *someone else* uploaded?
- **Default (recommended):** any logged-in user manages any file (shared team tool).
- Alternative: only the uploader + admin can modify a given file.

---

## 9. Open decisions (with my defaults)

| # | Question | Default |
|---|---|---|
| 1 | Who can modify another user's file (replace/remove/slug)? | ✅ DECIDED: Any logged-in user (shared team tool) |
| 2 | Max file size | 100 MB (configurable) |
| 3 | Allowed file types | Any (optional whitelist later) |
| 4 | `/f/:slug` behavior | 302 redirect (fast; exposes CDN url). Alt: proxy-stream to hide CDN |
| 5 | Removing a file | Delete DB rows + best-effort delete bytes from Bunny |
| 6 | Slug edit on a published link | Allowed, with a clear “existing links will break” warning |
| 7 | Duplicate filenames in one slot | Allowed (each gets its own slug) |
| 8 | Upload path | ✅ DECIDED: **A — server-proxy + streaming** on native Storage API |
| 9 | Public download path | ✅ DECIDED: **Pull Zone + 302 redirect**. Need the pull-zone hostname (set `BUNNY_PULL_ZONE_HOST`) before enabling bunny mode. |

---

## 10. File structure

```
mindgrove-file-upload/
  package.json            ✓ done
  .gitignore              ✓ done
  .env.example            ✓ done
  db.js                   ✓ done  (needs schema revision → page/section/variant)
  storage.js              ✓ done  (bunny + local)
  server.js               — express bootstrap, middleware, route mounting
  auth.js                 — session config, login/logout, role middleware, seed admin
  slug.js                 — generate + validate slugs
  routes/
    api.js                — taxonomy + files JSON API
    admin.js              — user management
    shorturl.js           — /f/:slug + /files/*
  views/
    layout.ejs
    login.ejs
    dashboard.ejs
    admin-users.ejs
    admin-taxonomy.ejs
  public/
    style.css
    app.js                — cascading dropdowns, cards, upload via fetch/FormData
  scripts/
    seed.js               — optional manual seeding
  Dockerfile              — for Bunny Magic Container / any host
  README.md
  data/                   — sqlite + local uploads (gitignored, created at runtime)
```

---

## 11. Deployment (Bunny)

1. **Bunny Storage zone** — create; note zone name + region host + password (access key).
2. **Bunny Pull Zone** — attach to the storage zone; note the `*.b-cdn.net` host (or custom domain).
3. **App host** — needs persistent disk for `data/`. Options:
   - Bunny **Magic Containers** (Docker) + a persistent volume mounted at `/app/data`, or
   - any small VPS / container platform.
4. Set env: `STORAGE_DRIVER=bunny`, Bunny keys, `BASE_URL=https://<app-domain>`,
   strong `SESSION_SECRET`, admin creds.
5. `docker build` + run (or `npm ci && npm start`).
6. Point your links at `https://<app-domain>/f/<slug>`.

> Note: the **short link** is served by the app domain, not the CDN — the app must stay up
> for links to resolve (it just issues a fast redirect). If you later want links that survive
> even when the app is down, we can move the redirect layer to Bunny Edge Scripting reading a
> synced slug→url map. Out of scope for v1.

---

## 12. Build phases

- **P1 — Core:** revise `db.js` schema, `auth.js` (sessions, login, seed admin), `server.js` bootstrap, role middleware.
- **P2 — Taxonomy:** cascading read API + dropdown UI (select-only for users).
- **P3 — Files:** upload / replace / remove / edit-slug + card UI + short URL generation.
- **P4 — Short URL:** `/f/:slug` redirect + local file serving.
- **P5 — Admin:** user management **+ full taxonomy CRUD screen** + history/rollback.
- **P6 — Hardening:** helmet, login rate limit, validation, size limits.
- **P7 — Ship:** Dockerfile + README + deploy notes.

Each phase runs and is testable before the next.

---

## 13. Status — SHIPPED ✅

All phases P1–P7 built and verified (backend via curl smoke test, frontend via browser).

- Auth (user/admin), sessions, seed admin — working, role gates enforced.
- Taxonomy cascade + admin-only CRUD — working.
- Upload / replace / edit-slug / delete / history / rollback — working, streaming + SHA-256.
- Short URL `/f/:slug` — 302 (pull zone) or proxy (local/no pull zone) — working.
- **0 npm vulnerabilities** (dropped `connect-sqlite3`→`sqlite3` chain for
  `better-sqlite3-session-store`; multer 2.x).
- Dockerfile + README + sample seed shipped.

### Remaining for production Bunny mode
1. Create a **Pull Zone** on `corevoice` → set `BUNNY_PULL_ZONE_HOST`.
2. Set `STORAGE_DRIVER=bunny`, strong `SESSION_SECRET`, real `BASE_URL`.
3. **Rotate** the storage access key (it was shared in chat).
