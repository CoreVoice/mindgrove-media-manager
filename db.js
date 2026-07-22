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

CREATE INDEX IF NOT EXISTS idx_redirects_link   ON redirects(link_id);
CREATE INDEX IF NOT EXISTS idx_sections_page    ON sections(page_id);
CREATE INDEX IF NOT EXISTS idx_variants_section ON variants(section_id);
CREATE INDEX IF NOT EXISTS idx_links_variant    ON links(variant_id);
`);

module.exports = db;
