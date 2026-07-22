'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- key/value app settings (e.g. active storage driver)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Taxonomy: page -> section -> variant (cascading tree)
CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (page_id, name)
);

CREATE TABLE IF NOT EXISTS variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (section_id, name)
);

-- A "link" is one uploaded file with a stable slug. Many per (page,section,variant).
-- The file lives directly on the row (no versioning); replacing overwrites these fields.
CREATE TABLE IF NOT EXISTS links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  section_id    INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  storage_path  TEXT    NOT NULL,
  cdn_url       TEXT    NOT NULL,
  driver        TEXT    NOT NULL,
  original_name TEXT    NOT NULL,
  mime          TEXT,
  size          INTEGER,
  checksum      TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Old slugs, kept so a rename never breaks a link already handed out.
-- GET /f/:old_slug forwards (302) to /f/<links.slug current value>.
CREATE TABLE IF NOT EXISTS redirects (
  old_slug   TEXT PRIMARY KEY,
  link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User-creatable, reusable labels (e.g. "datasheet", "firmware").
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS link_tags (
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (link_id, tag_id)
);

-- Approval queue. Every change a non-admin makes lands here as 'pending' until an
-- admin approves (applied via the shared mutation logic) or rejects (discarded).
-- kind: create | replace | slug | delete | tags
CREATE TABLE IF NOT EXISTS change_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  link_id       INTEGER REFERENCES links(id) ON DELETE CASCADE,
  payload       TEXT    NOT NULL DEFAULT '{}',   -- JSON: action-specific fields
  staged_path   TEXT,                            -- storage key of uploaded-but-unapproved bytes
  staged_driver TEXT,
  requested_by  INTEGER REFERENCES users(id),
  requested_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  note          TEXT
);

-- In-dashboard notifications (mirrors the email, but visible without one).
-- page_id/section_id/variant_id let a click restore that exact picker
-- selection; link_id is NOT foreign-keyed to links(id) so a later file
-- deletion never cascades away a user's notification about it.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  page_id    INTEGER,
  section_id INTEGER,
  variant_id INTEGER,
  link_id    INTEGER,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One-time password reset tokens, emailed to users.email.
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Who did what, when. actor_username is captured at write time so it stays
-- readable even if the user is later renamed or deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      INTEGER REFERENCES users(id),
  actor_username TEXT,
  action        TEXT    NOT NULL,   -- e.g. "link.create", "user.update", "settings.mail"
  entity_type   TEXT,
  entity_id     INTEGER,
  summary       TEXT    NOT NULL,
  details       TEXT,               -- JSON, optional
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_redirects_link   ON redirects(link_id);
CREATE INDEX IF NOT EXISTS idx_sections_page    ON sections(page_id);
CREATE INDEX IF NOT EXISTS idx_variants_section ON variants(section_id);
CREATE INDEX IF NOT EXISTS idx_links_variant    ON links(variant_id);
CREATE INDEX IF NOT EXISTS idx_link_tags_tag    ON link_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_cr_status        ON change_requests(status);
CREATE INDEX IF NOT EXISTS idx_cr_link          ON change_requests(link_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_token    ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_log(created_at);
`);

// --- guarded migrations (ALTER TABLE has no IF NOT EXISTS in sqlite) ---
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${decl}`);
}
ensureColumn('users', 'email', 'TEXT');

module.exports = db;
