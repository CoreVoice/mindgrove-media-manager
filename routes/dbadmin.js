'use strict';

// Direct SQLite table browser/editor for admins — phpMyAdmin-style power tool.
// Bypasses all app-level validation (storage cleanup, slug uniqueness rules, etc).
// Gated to admin only; identifiers are always checked against sqlite_master /
// PRAGMA table_info before being interpolated into SQL, never taken raw from input.

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();

function tableNames() {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}
function assertTable(name) {
  if (!tableNames().includes(name)) {
    const err = new Error('Unknown table');
    err.status = 404;
    throw err;
  }
}
function columnsOf(name) {
  return db.prepare(`PRAGMA table_info("${name}")`).all();
}
function withTable(handler) {
  return (req, res) => {
    try {
      assertTable(req.params.name);
      handler(req, res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  };
}

router.get('/tables', requireAdmin, (req, res) => {
  const tables = tableNames().map((name) => ({
    name,
    count: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
  }));
  res.json(tables);
});

router.get(
  '/tables/:name/rows',
  requireAdmin,
  withTable((req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db
      .prepare(`SELECT rowid AS _rowid, * FROM "${req.params.name}" ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM "${req.params.name}"`).get().n;
    res.json({ columns: columnsOf(req.params.name), rows, total, limit, offset });
  })
);

router.post(
  '/tables/:name/rows',
  requireAdmin,
  withTable((req, res) => {
    const cols = columnsOf(req.params.name).map((c) => c.name);
    const body = req.body || {};
    const useCols = Object.keys(body).filter((k) => cols.includes(k) && body[k] !== '');
    if (!useCols.length) return res.status(400).json({ error: 'No column values supplied' });
    const colList = useCols.map((c) => `"${c}"`).join(',');
    const placeholders = useCols.map(() => '?').join(',');
    const info = db
      .prepare(`INSERT INTO "${req.params.name}" (${colList}) VALUES (${placeholders})`)
      .run(...useCols.map((c) => body[c]));
    res.json({ ok: true, rowid: info.lastInsertRowid });
  })
);

router.patch(
  '/tables/:name/rows/:rowid',
  requireAdmin,
  withTable((req, res) => {
    const cols = columnsOf(req.params.name).map((c) => c.name);
    const body = req.body || {};
    const useCols = Object.keys(body).filter((k) => cols.includes(k));
    if (!useCols.length) return res.status(400).json({ error: 'No column values supplied' });
    const setSql = useCols.map((c) => `"${c}" = ?`).join(', ');
    const info = db
      .prepare(`UPDATE "${req.params.name}" SET ${setSql} WHERE rowid = ?`)
      .run(...useCols.map((c) => body[c]), req.params.rowid);
    if (!info.changes) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  })
);

router.delete(
  '/tables/:name/rows/:rowid',
  requireAdmin,
  withTable((req, res) => {
    const info = db.prepare(`DELETE FROM "${req.params.name}" WHERE rowid = ?`).run(req.params.rowid);
    if (!info.changes) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  })
);

// Raw SQL runner — same admin trust boundary as the rest of this router.
router.post('/query', requireAdmin, (req, res) => {
  const sql = String(req.body.sql || '').trim();
  if (!sql) return res.status(400).json({ error: 'sql required' });
  try {
    if (/^\s*(select|pragma|explain)\b/i.test(sql)) {
      const rows = db.prepare(sql).all();
      res.json({ ok: true, rows, rowCount: rows.length });
    } else {
      const info = db.prepare(sql).run();
      res.json({ ok: true, changes: info.changes, lastInsertRowid: info.lastInsertRowid });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
