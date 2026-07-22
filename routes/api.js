'use strict';

const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const db = require('../db');
const storage = require('../storage');
const settings = require('../settings');
const slugs = require('../slug');
const M = require('../mutations');
const CR = require('../changeRequests');
const audit = require('../audit');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const upload = multer({ dest: storage.TMP_DIR, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
const shortUrl = (req, slug) => `${baseUrl(req)}/f/${slug}`;
function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'file';
}
const cleanup = (file) => (file && file.path ? fs.unlink(file.path).catch(() => {}) : null);
const isAdmin = (req) => req.session.user.role === 'admin';

function parseTagInput(body) {
  let tagIds = [];
  let newNames = [];
  try { tagIds = JSON.parse(body.tagIds || '[]').map(Number).filter(Boolean); } catch (_) {}
  try { newNames = JSON.parse(body.newTags || '[]').map((s) => String(s).trim()).filter(Boolean); } catch (_) {}
  return { tagIds, newNames };
}

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
      `SELECT id, slug, label, original_name, mime, size, driver, checksum, updated_at, created_at
         FROM links WHERE variant_id = ? ORDER BY created_at DESC`
    )
    .all(req.params.id);
  const files = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    shortUrl: shortUrl(req, r.slug),
    originalName: r.original_name,
    mime: r.mime,
    size: r.size,
    driver: r.driver,
    checksum: r.checksum,
    tags: M.tagsFor(r.id),
    pending: CR.pendingForLink(r.id),
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  }));
  const pendingCreates = CR.pendingCreatesForVariant(req.params.id, req.session.user).map((c) => ({
    crId: c.id,
    label: c.payload.label,
    mime: c.payload.mime,
    size: c.payload.up ? c.payload.up.size : null,
    requestedBy: c.requestedBy,
    requestedAt: c.requested_at,
  }));
  res.json({ files, pendingCreates });
});

// ---------------------------------------------------------------------------
// Tags — list for the picker; creating a reusable tag name is immediate for all
// (it's shared vocabulary, not a file change). Assigning tags to a file goes
// through the same approval path as other edits (see PUT /links/:id/tags).
// ---------------------------------------------------------------------------
router.get('/tags', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM tags ORDER BY name').all());
});
router.post('/tags', requireAuth, (req, res) => {
  const id = M.ensureTag(req.body.name, req.session.user.id);
  if (!id) return res.status(400).json({ error: 'name required' });
  res.json(db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id));
});

// ---------------------------------------------------------------------------
// Taxonomy writes — ADMIN ONLY (unchanged)
// ---------------------------------------------------------------------------
const TAXO_SINGULAR = { pages: 'page', sections: 'section', variants: 'variant' };
function createTaxo(table, extraCol) {
  return (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      let info;
      if (extraCol) {
        const parentId = req.body[extraCol];
        if (!parentId) return res.status(400).json({ error: `${extraCol} required` });
        info = db.prepare(`INSERT INTO ${table} (${extraCol}, name, created_by) VALUES (?, ?, ?)`).run(parentId, name, req.session.user.id);
      } else {
        info = db.prepare(`INSERT INTO ${table} (name, created_by) VALUES (?, ?)`).run(name, req.session.user.id);
      }
      audit.log(req.session.user.id, `${TAXO_SINGULAR[table]}.create`, { entityType: TAXO_SINGULAR[table], entityId: info.lastInsertRowid, summary: `Created ${TAXO_SINGULAR[table]} "${name}"` });
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
      audit.log(req.session.user.id, `${TAXO_SINGULAR[table]}.rename`, { entityType: TAXO_SINGULAR[table], entityId: Number(req.params.id), summary: `Renamed ${TAXO_SINGULAR[table]} → "${name}"` });
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
  audit.log(req.session.user.id, 'page.delete', { entityType: 'page', entityId: Number(req.params.id), summary: 'Deleted a page (cascaded to its sections/variants/files)' });
  res.json({ ok: true });
});
router.post('/sections', requireAdmin, createTaxo('sections', 'page_id'));
router.patch('/sections/:id', requireAdmin, renameTaxo('sections'));
router.delete('/sections/:id', requireAdmin, async (req, res) => {
  await purgeLinksWhere('section_id = ?', req.params.id);
  const info = db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  audit.log(req.session.user.id, 'section.delete', { entityType: 'section', entityId: Number(req.params.id), summary: 'Deleted a section (cascaded to its variants/files)' });
  res.json({ ok: true });
});
router.post('/variants', requireAdmin, createTaxo('variants', 'section_id'));
router.patch('/variants/:id', requireAdmin, renameTaxo('variants'));
router.delete('/variants/:id', requireAdmin, async (req, res) => {
  await purgeLinksWhere('variant_id = ?', req.params.id);
  const info = db.prepare('DELETE FROM variants WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  audit.log(req.session.user.id, 'variant.delete', { entityType: 'variant', entityId: Number(req.params.id), summary: 'Deleted a variant (cascaded to its files)' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Files — admin applies immediately; a normal user's change is queued for review
// ---------------------------------------------------------------------------

function slugPendingInCreate(slug) {
  return !!db
    .prepare("SELECT 1 FROM change_requests WHERE kind = 'create' AND status = 'pending' AND json_extract(payload,'$.slug') = ?")
    .get(slug);
}

// POST /api/upload  (multipart: variant_id, slug?, tagIds?, newTags?, file)
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.body.variant_id);
    if (!variant) return res.status(400).json({ error: 'Invalid variant' });
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(variant.section_id);

    // resolve slug
    let slug;
    if (req.body.slug && String(req.body.slug).trim()) {
      slug = slugs.normalizeSlug(req.body.slug);
      if (!slugs.isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug (3-64 chars, a-z 0-9 -)' });
      if (slugs.slugExists(slug) || slugPendingInCreate(slug)) return res.status(409).json({ error: 'Slug already taken' });
    } else {
      slug = slugs.uniqueSlug();
    }

    const driver = settings.activeDriver();
    if (!storage.isConfigured(driver))
      return res.status(400).json({ error: `Active storage "${driver}" is selected but not configured` });

    // duplicate guard — same filename + checksum already in this variant slot
    const digest = await storage.hashFile(req.file.path);
    if (M.duplicateInVariant(variant.id, req.file.originalname, digest.hex)) {
      return res.status(409).json({ error: 'An identical file (same name and contents) already exists in this variant.' });
    }

    const label = req.file.originalname || 'file';
    const parsed = parseTagInput(req.body);
    const tagIds = M.resolveTagIds({ tagIds: parsed.tagIds, newNames: parsed.newNames }, req.session.user.id);
    const key = `${slug}/${storage.token()}-${safeName(req.file.originalname)}`;
    const up = await storage.uploadFile(key, req.file.path, req.file.mimetype, driver, digest);

    if (isAdmin(req)) {
      const linkId = M.insertLink({
        slug, pageId: section.page_id, sectionId: variant.section_id, variantId: variant.id,
        label, up, mime: req.file.mimetype, originalName: label, byUserId: req.session.user.id,
      });
      if (tagIds.length) M.setTags(linkId, tagIds);
      return res.json({ id: linkId, slug, shortUrl: shortUrl(req, slug), applied: true });
    }

    // user → queue; bytes already uploaded to the final key await approval
    const crId = CR.queue('create', {
      byUserId: req.session.user.id,
      staged: { path: up.storagePath, driver: up.driver },
      payload: {
        slug, pageId: section.page_id, sectionId: variant.section_id, variantId: variant.id,
        label, up, mime: req.file.mimetype, originalName: label, tagIds,
      },
    });
    res.json({ crId, pending: true, slug });
  } finally {
    await cleanup(req.file);
  }
});

// POST /api/links/:id/replace  (multipart: file)
router.post('/links/:id/replace', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Not found' });

    const driver = settings.activeDriver();
    if (!storage.isConfigured(driver))
      return res.status(400).json({ error: `Active storage "${driver}" is selected but not configured` });

    const digest = await storage.hashFile(req.file.path);
    if (M.duplicateInVariant(link.variant_id, req.file.originalname, digest.hex, link.id)) {
      return res.status(409).json({ error: 'An identical file already exists elsewhere in this variant.' });
    }

    const key = `${link.slug}/${storage.token()}-${safeName(req.file.originalname)}`;
    const up = await storage.uploadFile(key, req.file.path, req.file.mimetype, driver, digest);

    if (isAdmin(req)) {
      await M.replaceFile(link, up, req.file.originalname, req.file.mimetype, req.session.user.id);
      return res.json({ id: link.id, slug: link.slug, shortUrl: shortUrl(req, link.slug), applied: true });
    }

    const crId = CR.queue('replace', {
      byUserId: req.session.user.id,
      linkId: link.id,
      staged: { path: up.storagePath, driver: up.driver },
      payload: { up, originalName: req.file.originalname, mime: req.file.mimetype },
    });
    res.json({ crId, pending: true });
  } finally {
    await cleanup(req.file);
  }
});

// PATCH /api/links/:id/slug  { slug }
router.patch('/links/:id/slug', requireAuth, (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  const slug = slugs.normalizeSlug(req.body.slug);
  if (!slugs.isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug (3-64 chars, a-z 0-9 -)' });
  if (slug === link.slug) return res.json({ id: link.id, slug, shortUrl: shortUrl(req, slug), applied: true });
  if (slugs.slugExists(slug) || slugPendingInCreate(slug)) return res.status(409).json({ error: 'Slug already taken' });

  if (isAdmin(req)) {
    M.renameSlug(link, slug, req.session.user.id);
    return res.json({ id: link.id, slug, shortUrl: shortUrl(req, slug), applied: true });
  }
  const crId = CR.queue('slug', { byUserId: req.session.user.id, linkId: link.id, payload: { slug } });
  res.json({ crId, pending: true });
});

// DELETE /api/links/:id
router.delete('/links/:id', requireAuth, async (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  if (isAdmin(req)) {
    await M.deleteLink(link, req.session.user.id);
    return res.json({ ok: true, applied: true });
  }
  const crId = CR.queue('delete', { byUserId: req.session.user.id, linkId: link.id });
  res.json({ crId, pending: true });
});

// PUT /api/links/:id/tags  { tagIds:[], newTags:[] }
router.put('/links/:id/tags', requireAuth, (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  const tagIds = (Array.isArray(req.body.tagIds) ? req.body.tagIds : []).map(Number).filter(Boolean);
  const newNames = (Array.isArray(req.body.newTags) ? req.body.newTags : []).map((s) => String(s).trim()).filter(Boolean);

  if (isAdmin(req)) {
    M.setTags(link.id, M.resolveTagIds({ tagIds, newNames }, req.session.user.id), req.session.user.id);
    return res.json({ ok: true, applied: true, tags: M.tagsFor(link.id) });
  }
  const crId = CR.queue('tags', { byUserId: req.session.user.id, linkId: link.id, payload: { tagIds, newNames } });
  res.json({ crId, pending: true });
});

module.exports = router;
