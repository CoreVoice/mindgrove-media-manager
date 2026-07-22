'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const storageConfig = require('../storageConfig');
const { requireAdmin } = require('../auth');

const router = express.Router();

// --- storage config (driver + Bunny/S3 credentials) ---
router.get('/settings', requireAdmin, (req, res) => {
  res.json(storageConfig.publicView());
});

router.put('/settings', requireAdmin, (req, res) => {
  const driver = req.body.driver;
  if (!['local', 'bunny', 's3'].includes(driver))
    return res.status(400).json({ error: 'driver must be "local", "bunny", or "s3"' });

  // save credentials/fields first WITHOUT changing the active driver
  storageConfig.update({ bunny: req.body.bunny, s3: req.body.s3 });

  // only switch the active driver if that driver is now fully configured
  if (!storageConfig.publicView().configured[driver]) {
    return res.status(400).json({
      error: `"${driver}" storage is missing required credentials. Fill them in and save again.`,
    });
  }
  storageConfig.update({ driver });
  res.json({ ok: true, ...storageConfig.publicView() });
});

router.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, active, created_at FROM users ORDER BY username').all());
});

router.post('/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!username || password.length < 8)
    return res.status(400).json({ error: 'username and password (min 8 chars) required' });
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 12), role);
    res.json({ id: info.lastInsertRowid, username, role, active: 1 });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username taken' });
    throw e;
  }
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const sets = [];
  const args = [];
  if (typeof req.body.active === 'boolean') {
    if (user.id === req.session.user.id && !req.body.active)
      return res.status(400).json({ error: 'Cannot deactivate yourself' });
    sets.push('active = ?');
    args.push(req.body.active ? 1 : 0);
  }
  if (req.body.role === 'admin' || req.body.role === 'user') {
    if (user.id === req.session.user.id && req.body.role !== 'admin')
      return res.status(400).json({ error: 'Cannot demote yourself' });
    sets.push('role = ?');
    args.push(req.body.role);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8)
      return res.status(400).json({ error: 'Password min 8 chars' });
    sets.push('password_hash = ?');
    args.push(bcrypt.hashSync(String(req.body.password), 12));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  args.push(user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

module.exports = router;
