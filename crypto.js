'use strict';

// Small AES-256-GCM helper for encrypting secrets at rest in the settings table.
// Key is derived from APP_SECRET (or SESSION_SECRET). If that changes, previously
// stored secrets can no longer be decrypted and must be re-entered.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function key() {
  const material = process.env.APP_SECRET || process.env.SESSION_SECRET || 'insecure-dev-secret';
  return crypto.createHash('sha256').update(material).digest(); // 32 bytes
}

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(stored) {
  if (!stored || !String(stored).startsWith(PREFIX)) return '';
  try {
    const raw = Buffer.from(String(stored).slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

module.exports = { encrypt, decrypt };
