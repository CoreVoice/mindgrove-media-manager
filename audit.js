'use strict';

const db = require('./db');

/**
 * Record a CRUD event. Call this at the point of mutation, not at the HTTP
 * layer, so queued (approved-later) and instant (admin) changes both log
 * consistently through the same code path.
 */
function log(actorId, action, { entityType = null, entityId = null, summary, details = null } = {}) {
  let username = null;
  if (actorId) {
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(actorId);
    username = u ? u.username : null;
  }
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_username, action, entity_type, entity_id, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(actorId || null, username, action, entityType, entityId, summary, details ? JSON.stringify(details) : null);
}

function list({ limit = 50, offset = 0, action = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const where = action ? 'WHERE action = ?' : '';
  const args = action ? [action, lim, off] : [lim, off];
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args);
  const total = action
    ? db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n
    : db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
  return { rows, total, actions };
}

module.exports = { log, list };
