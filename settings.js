'use strict';

const db = require('./db');

function get(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function set(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/**
 * Active storage driver for NEW uploads: admin setting, else env, else 'local'.
 * Existing files keep serving from whatever driver they were stored with.
 */
function activeDriver() {
  let cfgDriver = null;
  try {
    cfgDriver = (JSON.parse(get('storage_config', '') || '{}') || {}).driver || null;
  } catch (_) {
    cfgDriver = null;
  }
  const v = cfgDriver || (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  return ['local', 'bunny', 's3'].includes(v) ? v : 'local';
}

module.exports = { get, set, activeDriver };
