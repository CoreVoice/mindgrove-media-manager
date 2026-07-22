'use strict';

const settings = require('./settings');
const { encrypt, decrypt } = require('./crypto');

const CFG_KEY = 'mail_config';
const SEC = { smtpUser: 'sec_smtp_user', smtpPass: 'sec_smtp_pass' };

function readJson() {
  try {
    return JSON.parse(settings.get(CFG_KEY, '') || '{}');
  } catch (_) {
    return {};
  }
}
const pick = (v, envVal) => (v !== undefined && v !== null && v !== '' ? v : envVal || '');

/** Effective mail config (secrets decrypted, env as fallback). */
function resolve() {
  const c = readJson();
  const host = pick(c.host, process.env.SMTP_HOST);
  const port = Number(pick(c.port, process.env.SMTP_PORT) || 587);
  const secure = c.secure !== undefined ? !!c.secure : String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const user = decrypt(settings.get(SEC.smtpUser)) || process.env.SMTP_USER || '';
  const pass = decrypt(settings.get(SEC.smtpPass)) || process.env.SMTP_PASS || '';
  const fromAddress = pick(c.fromAddress, process.env.MAIL_FROM);
  const notifyTo = pick(c.notifyTo, process.env.MAIL_NOTIFY_TO);
  const configured = !!(host && user && pass && fromAddress);
  return { host, port, secure, user, pass, fromAddress, notifyTo, configured };
}

/** Safe view for the browser — no secret values, only "set" flags. */
function publicView() {
  const c = resolve();
  return {
    host: c.host, port: c.port, secure: c.secure, fromAddress: c.fromAddress, notifyTo: c.notifyTo,
    configured: c.configured, userSet: !!c.user, passSet: !!c.pass,
  };
}

/** Merge & persist admin-submitted config. Blank secret fields keep the existing value. */
function update(input = {}) {
  const cur = readJson();
  const next = { ...cur };
  for (const f of ['host', 'port', 'secure', 'fromAddress', 'notifyTo']) if (input[f] !== undefined) next[f] = input[f];
  if (input.smtpUser) settings.set(SEC.smtpUser, encrypt(input.smtpUser));
  if (input.smtpPass) settings.set(SEC.smtpPass, encrypt(input.smtpPass));
  settings.set(CFG_KEY, JSON.stringify(next));
  return resolve();
}

module.exports = { resolve, publicView, update };
