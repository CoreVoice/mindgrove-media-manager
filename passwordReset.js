'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const mailer = require('./mailer');
const audit = require('./audit');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Always resolves with the same shape regardless of whether the account/email
 * exists — never leak account existence to an unauthenticated caller.
 */
async function requestReset(usernameOrEmail) {
  const q = String(usernameOrEmail || '').trim();
  if (!q) return;
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(q, q);
  if (!user || !user.email || !user.active) return;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

  const resetUrl = `${baseUrl()}/reset-password?token=${token}`;
  await mailer.passwordResetEmail({ toEmail: user.email, resetUrl });
  audit.log(user.id, 'user.password_reset_requested', { entityType: 'user', entityId: user.id, summary: `Password reset requested for "${user.username}"` });
}

function validToken(token) {
  if (!token) return null;
  const row = db
    .prepare("SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime('now')")
    .get(token);
  return row || null;
}

function consumeToken(token, newPassword) {
  const row = validToken(token);
  if (!row) return { ok: false, error: 'This reset link is invalid or has expired.' };
  if (String(newPassword || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(row.user_id);
  });
  tx();
  audit.log(row.user_id, 'user.password_reset', { entityType: 'user', entityId: row.user_id, summary: 'Password reset via emailed link' });
  return { ok: true };
}

module.exports = { requestReset, validToken, consumeToken };
