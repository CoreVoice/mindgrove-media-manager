'use strict';

const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const db = require('../db');
const storage = require('../storage');
const settings = require('../settings');
const slugs = require('../slug');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const upload = multer({ dest: storage.TMP_DIR, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
const shortUrl = (req, slug) => `${baseUrl(req)}/f/${slug}`;
function safeName(name) {
  return (
    String(name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'file'
  );
}
const cleanup = (file) => (file && file.path ? fs.unlink(file.path).catch(() => {}) : null);

// ---------------------------------------------------------------------------
// Taxonomy reads — any authenticated user
// ---------------------------------------------------------------------------
router.get('/pages', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM pages ORDER BY name').all());
});
router.get('/pages/:id/sections', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM sections WHERE page_id = ? ORDER BY name').all(req.params.id));
});
router.get('/sections/:id/variants', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM variants WHERE section_id = ? ORDER BY name').all(req.params.id));
});
router.get('/variants/:id/files', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, slug, label, original_name, mime, size, driver, updated_at, created_at
         FROM links WHERE variant_id = ? ORDER BY created_at DESC`
    )
    .all(req.params.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      label: r.label,
      shortUrl: shortUrl(req, r.slug),
      originalName: r.original_name,
      mime: r.mime,
      size: r.size,
      driver: r.driver,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
    }))
  );
});

// ---------------------------------------------------------------------------
// Taxonomy writes — ADMIN ONLY
// ---------------------------------------------------------------------------
function createTaxo(table, extraCol) {
  return (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      let info;
      if (extraCol) {
        const parentId = req.body[extraCol];
        if (!parentId) return res.status(400).json({ error: `${extraCol} required` });
        info = db
          .prepare(`INSERT INTO ${table} (${extraCol}, name, created_by) VALUES (?, ?, ?)`)
          .run(parentId, name, req.session.user.id);
      } else {
        info = db.prepare(`INSERT INTO ${table} (name, created_by) VALUES (?, ?)`).run(name, req.session.user.id);
      }
      res.json({ id: info.lastInsertRowid, name });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Already exists' });
      throw e;
    }
  };
}
function renameTaxo(table) {
  return (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const info = db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, req.params.id);
      if (!info.changes) return res.status(404).json({ error: 'Not found' });
      res.json({ id: Number(req.params.id), name });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Already exists' });
      throw e;
    }
  };
}
async function purgeLinksWhere(whereSql, param) {
  const links = db.prepare(`SELECT storage_path, driver FROM links WHERE ${whereSql}`).all(param);
  for (const l of links) await storage.remove(l.storage_path, l.driver);
}

router.post('/pages', requireAdmin, createTaxo('pages', null));
router.patch('/pages/:id', requireAdmin, renameTaxo('pages'));
router.delete('/pages/:id', requireAdmin, async (req, res) => {
  await purgeLinksWhere('page_id = ?', req.params.id);
  const info = db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/sections', requireAdmin, createTaxo('sections', 'page_id'));
router.patch('/sections/:id', requireAdmin, renameTaxo('sections'));
router.delete('/sections/:id', requireAdmin, async (req, res) => {
  await purgeLinksWhere('section_id = ?', req.params.id);
  const info = db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/variants', requireAdmin, createTaxo('variants', 'section_id'));
router.patch('/variants/:id', requireAdmin, renameTaxo('variants'));
router.delete('/variants/:id', requireAdmin, async (req, res) => {
  await purgeLinksWhere('variant_id = ?', req.params.id);
  const info = db.prepare('DELETE FROM variants WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Files: upload (new link), replace (overwrite file), slug edit, delete
// ---------------------------------------------------------------------------

// POST /api/upload  (multipart: variant_id, slug?, file)
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.body.variant_id);
    if (!variant) return res.status(400).json({ error: 'Invalid variant' });
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(variant.section_id);

    let slug;
    if (req.body.slug && String(req.body.slug).trim()) {
      slug = slugs.normalizeSlug(req.body.slug);
      if (!slugs.isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug (3-64 chars, a-z 0-9 -)' });
      if (slugs.slugExists(slug)) return res.status(409).json({ error: 'Slug already taken' });
    } else {
      slug = slugs.uniqueSlug();
    }

    const driver = settings.activeDriver();
    if (!storage.isConfigured(driver))
      return res.status(400).json({ error: `Active storage "${driver}" is selected but not configured` });

    const label = req.file.originalname || 'file';
    const key = `${slug}/${storage.token()}-${safeName(req.file.originalname)}`;
    const up = await storage.uploadFile(key, req.file.path, req.file.mimetype, driver);

    const info = db
      .prepare(
        `INSERT INTO links
           (slug, page_id, section_id, variant_id, label, storage_path, cdn_url, driver, original_name, mime, size, checksum, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(slug, section.page_id, variant.section_id, variant.id, label, up.storagePath, up.cdnUrl, up.driver, label, req.file.mimetype, up.size, up.checksum, req.session.user.id);

    res.json({ id: info.lastInsertRowid, slug, label, shortUrl: shortUrl(req, slug) });
  } finally {
    await cleanup(req.file);
  }
});

// POST /api/links/:id/replace  (multipart: file) -> overwrite, same slug
router.post('/links/:id/replace', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Not found' });

    const driver = settings.activeDriver();
    if (!storage.isConfigured(driver))
      return res.status(400).json({ error: `Active storage "${driver}" is selected but not configured` });

    const oldPath = link.storage_path;
    const oldDriver = link.driver;
    const key = `${link.slug}/${storage.token()}-${safeName(req.file.originalname)}`;
    const up = await storage.uploadFile(key, req.file.path, req.file.mimetype, driver);

    db.prepare(
      `UPDATE links SET label = ?, storage_path = ?, cdn_url = ?, driver = ?, original_name = ?, mime = ?, size = ?, checksum = ?, updated_at = datetime('now')
         WHERE id = ?`
    ).run(req.file.originalname, up.storagePath, up.cdnUrl, up.driver, req.file.originalname, req.file.mimetype, up.size, up.checksum, link.id);

    // remove the previous bytes (best-effort) after the new upload succeeded
    await storage.remove(oldPath, oldDriver);

    res.json({ id: link.id, slug: link.slug, shortUrl: shortUrl(req, link.slug) });
  } finally {
    await cleanup(req.file);
  }
});

// PATCH /api/links/:id/slug  { slug }
// Renaming keeps the old slug alive as a redirect, so a link handed out before
// the rename never 404s — it forwards to the current slug instead.
router.patch('/links/:id/slug', requireAuth, (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  const slug = slugs.normalizeSlug(req.body.slug);
  if (!slugs.isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug (3-64 chars, a-z 0-9 -)' });
  if (slug === link.slug) return res.json({ id: link.id, slug, shortUrl: shortUrl(req, slug) });
  if (slugs.slugExists(slug)) return res.status(409).json({ error: 'Slug already taken' });

  const rename = db.transaction(() => {
    db.prepare('INSERT INTO redirects (old_slug, link_id) VALUES (?, ?)').run(link.slug, link.id);
    db.prepare('UPDATE links SET slug = ? WHERE id = ?').run(slug, link.id);
  });
  rename();

  res.json({ id: link.id, slug, shortUrl: shortUrl(req, slug) });
});

// DELETE /api/links/:id
router.delete('/links/:id', requireAuth, async (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  await storage.remove(link.storage_path, link.driver);
  db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
  res.json({ ok: true });
});

module.exports = router;
