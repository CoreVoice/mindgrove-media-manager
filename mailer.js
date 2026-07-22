'use strict';

const mailConfig = require('./mailConfig');

let _transport = { client: null, sig: null };
function transport(cfg) {
  const sig = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (_transport.client && _transport.sig === sig) return _transport.client;
  const nodemailer = require('nodemailer');
  const client = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  _transport = { client, sig };
  return client;
}

/** Fire-and-forget send. Never throws — a mail outage must never break approvals/uploads. */
async function send({ to, subject, text }) {
  const cfg = mailConfig.resolve();
  if (!cfg.configured || !to) return { sent: false, reason: !cfg.configured ? 'not configured' : 'no recipient' };
  try {
    await transport(cfg).sendMail({ from: cfg.fromAddress, to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendTest(to) {
  return send({ to, subject: 'Mindgrove Media Manager — test email', text: 'SMTP is configured correctly. This is a test message.' });
}

function describeChange(kind, payload) {
  switch (kind) {
    case 'create': return `upload "${payload.label}" → /f/${payload.slug}`;
    case 'replace': return `replace the file with "${payload.originalName}"`;
    case 'slug': return `rename the short link to /f/${payload.slug}`;
    case 'delete': return 'delete the file';
    case 'tags': return 'change the tags';
    default: return kind;
  }
}

/** Notify the admin notify-to address that a change is waiting for review. */
function notifyAdminPending({ kind, payload, requestedByUsername }) {
  const cfg = mailConfig.resolve();
  return send({
    to: cfg.notifyTo,
    subject: 'Mindgrove: a change is waiting for approval',
    text: `${requestedByUsername} asked to ${describeChange(kind, payload)}.\n\nReview it: ${baseUrl()}/admin/approvals`,
  });
}

/** Notify the requesting user once their change is approved (live) or rejected. */
function notifyUserReviewed({ toEmail, kind, payload, status, note }) {
  if (status === 'approved') {
    return send({
      to: toEmail,
      subject: 'Your Mindgrove change is live',
      text: `Your request to ${describeChange(kind, payload)} was approved and is now live.`,
    });
  }
  return send({
    to: toEmail,
    subject: 'Your Mindgrove change was rejected',
    text: `Your request to ${describeChange(kind, payload)} was rejected.${note ? `\n\nNote: ${note}` : ''}`,
  });
}

function passwordResetEmail({ toEmail, resetUrl }) {
  return send({
    to: toEmail,
    subject: 'Reset your Mindgrove password',
    text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore it.`,
  });
}

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

module.exports = { send, sendTest, notifyAdminPending, notifyUserReviewed, passwordResetEmail };
