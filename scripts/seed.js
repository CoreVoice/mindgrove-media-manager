'use strict';

// Optional convenience seed: admin (via auth.seedAdmin) + a sample taxonomy tree.
// Run: npm run seed
require('dotenv').config();
const db = require('../db');
const { seedAdmin } = require('../auth');

seedAdmin();

function ensure(table, where, insert) {
  const cols = Object.keys(where);
  const found = db
    .prepare(`SELECT * FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`)
    .get(...cols.map((c) => where[c]));
  if (found) return found;
  const all = { ...where, ...insert };
  const keys = Object.keys(all);
  const info = db
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => all[k]));
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
}

const page = ensure('pages', { name: 'Home' }, {});
const section = ensure('sections', { page_id: page.id, name: 'Hero' }, {});
ensure('variants', { section_id: section.id, name: 'Desktop' }, {});
ensure('variants', { section_id: section.id, name: 'Mobile' }, {});

console.log('Seeded sample taxonomy: Home → Hero → {Desktop, Mobile}');
