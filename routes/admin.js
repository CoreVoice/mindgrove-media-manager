'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const storageConfig = require('../storageConfig');
const mailConfig = require('../mailConfig');
const mailer = require('../mailer');
const audit = require('../audit');
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
  audit.log(req.session.user.id, 'settings.storage', { entityType: 'settings', summary: `Set active storage driver to "${driver}"` });
  res.json({ ok: true, ...storageConfig.publicView() });
});

// --- mail config (SMTP / AWS SES) ---
router.get('/mail-settings', requireAdmin, (req, res) => {
  res.json(mailConfig.publicView());
});

router.put('/mail-settings', requireAdmin, (req, res) => {
  mailConfig.update({
    host: req.body.host, port: Number(req.body.port) || undefined, secure: !!req.body.secure,
    fromAddress: req.body.fromAddress, notifyTo: req.body.notifyTo,
    smtpUser: req.body.smtpUser, smtpPass: req.body.smtpPass,
  });
  audit.log(req.session.user.id, 'settings.mail', { entityType: 'settings', summary: 'Updated mail (SMTP) settings' });
  res.json({ ok: true, ...mailConfig.publicView() });
});

router.post('/mail-settings/test', requireAdmin, async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: 'to address required' });
  const r = await mailer.sendTest(to);
  if (!r.sent) return res.status(400).json({ error: r.reason || 'Send failed' });
  res.json({ ok: true });
});

// --- users ---
router.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, email, role, active, created_at FROM users ORDER BY username').all());
});

router.post('/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim() || null;
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!username || password.length < 8)
    return res.status(400).json({ error: 'username and password (min 8 chars) required' });
  try {
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(username, email, bcrypt.hashSync(password, 12), role);
    audit.log(req.session.user.id, 'user.create', { entityType: 'user', entityId: info.lastInsertRowid, summary: `Created user "${username}" (${role})` });
    res.json({ id: info.lastInsertRowid, username, email, role, active: 1 });
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
  const changes = [];
  if (typeof req.body.active === 'boolean') {
    if (user.id === req.session.user.id && !req.body.active)
      return res.status(400).json({ error: 'Cannot deactivate yourself' });
    sets.push('active = ?'); args.push(req.body.active ? 1 : 0);
    changes.push(req.body.active ? 'enabled' : 'disabled');
  }
  if (req.body.role === 'admin' || req.body.role === 'user') {
    if (user.id === req.session.user.id && req.body.role !== 'admin')
      return res.status(400).json({ error: 'Cannot demote yourself' });
    sets.push('role = ?'); args.push(req.body.role);
    changes.push(`role → ${req.body.role}`);
  }
  if (req.body.email !== undefined) {
    sets.push('email = ?'); args.push(String(req.body.email || '').trim() || null);
    changes.push('email updated');
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8)
      return res.status(400).json({ error: 'Password min 8 chars' });
    sets.push('password_hash = ?'); args.push(bcrypt.hashSync(String(req.body.password), 12));
    changes.push('password reset');
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  args.push(user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  audit.log(req.session.user.id, 'user.update', { entityType: 'user', entityId: user.id, summary: `Updated user "${user.username}": ${changes.join(', ')}` });
  res.json({ ok: true });
});

module.exports = router;
