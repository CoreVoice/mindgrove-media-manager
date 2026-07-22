'use strict';

const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const bcrypt = require('bcryptjs');
const db = require('./db');

function sessionMiddleware() {
  const secure = String(process.env.BASE_URL || '').startsWith('https://');
  return session({
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });
}

/** Seed the admin account on first run (only when the users table is empty). */
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    username,
    hash,
    'admin'
  );
  console.log(`[auth] Seeded admin user "${username}". Change the password after first login.`);
}

// --- simple in-memory login throttle ---
const attempts = new Map(); // key -> { count, first }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttled(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}

function clearFailures(key) {
  attempts.delete(key);
}

/** Verify credentials. Returns the user row (minus hash) or null. */
function verify(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !user.active) return null;
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

// --- middleware ---
function attachUser(req, res, next) {
  res.locals.user = req.session.user || null;
  next();
}

function wantsJson(req) {
  return (
    req.originalUrl.startsWith('/api') ||
    req.xhr ||
    !!req.get('X-Requested-With') ||
    (req.get('accept') || '').includes('application/json')
  );
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (wantsJson(req)) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = {
  sessionMiddleware,
  seedAdmin,
  verify,
  attachUser,
  requireAuth,
  requireAdmin,
  throttled,
  noteFailure,
  clearFailures,
};
