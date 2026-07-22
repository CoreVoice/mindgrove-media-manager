'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');

const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// --- view engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- security + parsers ---
app.use(helmet({ contentSecurityPolicy: false })); // internal tool; CSP off to keep v1 simple
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- static assets ---
app.use('/public', express.static(path.join(__dirname, 'public')));
// Local-driver file serving (dev fallback). No-op in bunny mode.
app.use('/files', express.static(storage.LOCAL_DIR));

// --- sessions ---
app.use(auth.sessionMiddleware());
app.use(auth.attachUser);
// expose pending-approval count to views (nav badge), admins only
app.use((req, res, next) => {
  res.locals.pendingCount = 0;
  if (req.session.user && req.session.user.role === 'admin') {
    try { res.locals.pendingCount = require('./changeRequests').pendingCount(); } catch (_) {}
  }
  next();
});

// --- public short URL (before auth gate) ---
app.use('/', require('./routes/shorturl'));

// --- auth pages ---
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const key = `${req.ip}:${String(req.body.username || '').toLowerCase()}`;
  if (auth.throttled(key)) {
    return res.status(429).render('login', { error: 'Too many attempts. Try again later.' });
  }
  const user = auth.verify(req.body.username, req.body.password);
  if (!user) {
    auth.noteFailure(key);
    return res.status(401).render('login', { error: 'Invalid username or password.' });
  }
  auth.clearFailures(key);
  req.session.user = user;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- app pages ---
app.get('/', auth.requireAuth, (req, res) => {
  res.render('dashboard', { user: req.session.user, page: 'dashboard' });
});

app.get('/admin', auth.requireAdmin, (req, res) => res.redirect('/admin/users'));
app.get('/admin/users', auth.requireAdmin, (req, res) => {
  res.render('admin-users', { user: req.session.user, page: 'users' });
});
app.get('/admin/taxonomy', auth.requireAdmin, (req, res) => {
  res.render('admin-taxonomy', { user: req.session.user, page: 'taxonomy' });
});
app.get('/admin/settings', auth.requireAdmin, (req, res) => {
  res.render('admin-settings', { user: req.session.user, page: 'settings' });
});
app.get('/admin/database', auth.requireAdmin, (req, res) => {
  res.render('admin-database', { user: req.session.user, page: 'database' });
});
app.get('/admin/backup', auth.requireAdmin, (req, res) => {
  res.render('admin-backup', { user: req.session.user, page: 'backup' });
});
app.get('/admin/approvals', auth.requireAdmin, (req, res) => {
  res.render('admin-approvals', { user: req.session.user, page: 'approvals' });
});

// --- API ---
app.use('/api', require('./routes/api'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/db', require('./routes/dbadmin'));
app.use('/api/admin', require('./routes/backup'));
app.use('/api/admin', require('./routes/approvals'));

// --- 404 + errors ---
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_MB || 100} MB)` });
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Server error' });
  res.status(500).send('Server error');
});

// --- boot ---
auth.seedAdmin();
const settings = require('./settings');
const storageConfig = require('./storageConfig');
app.listen(PORT, () => {
  const driver = settings.activeDriver();
  const cfg = storageConfig.resolve();
  let note = '';
  if (driver === 'bunny' && !cfg.bunny.hasPullZone) note = ' (proxy mode — no pull zone)';
  if (driver === 's3' && !cfg.s3.publicBaseUrl) note = ' (proxy mode — no public URL)';
  console.log(`[server] listening on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`[server] active storage driver: ${driver}${note} · admin can switch at /admin/settings`);
});

module.exports = app;
