'use strict';

// Export/import of the "link map" — taxonomy + links + redirects only.
// Deliberately excludes users (password hashes), sessions, and settings
// (encrypted storage credentials). This is meant to be a safe, git-diffable
// log of every short URL ever issued and what it currently points to — not
// a full database backup.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const db = require('../db');
const slugs = require('../slug');
const storage = require('../storage');
const { requireAdmin } = require('../auth');

const router = express.Router();
const upload = multer({ dest: storage.TMP_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

const EXPORT_VERSION = 1;

router.get('/export', requireAdmin, (req, res) => {
  const data = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    note: 'Taxonomy + link/slug map only. No users, sessions, or storage credentials.',
    pages: db.prepare('SELECT id, name FROM pages ORDER BY id').all(),
    sections: db.prepare('SELECT id, page_id, name FROM sections ORDER BY id').all(),
    variants: db.prepare('SELECT id, section_id, name FROM variants ORDER BY id').all(),
    links: db
      .prepare(
        `SELECT id, slug, page_id, section_id, variant_id, label, storage_path, cdn_url,
                driver, original_name, mime, size, checksum, created_at, updated_at
           FROM links ORDER BY id`
      )
      .all(),
    redirects: db.prepare('SELECT old_slug, link_id, created_at FROM redirects ORDER BY old_slug').all(),
  };
  const stamp = data.exportedAt.slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="mindgrove-links-export-${stamp}.json"`);
  res.json(data);
});

// POST /api/admin/import (multipart: file = exported JSON)
// Never overwrites an existing slug/redirect — only adds what's missing.
// Matches taxonomy by (parent, name) so importing into a non-empty db merges
// cleanly instead of duplicating pages/sections/variants that already exist.
router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const raw = await fs.readFile(req.file.path, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return res.status(400).json({ error: 'Not valid JSON' });
    }
    if (!data || !Array.isArray(data.links)) {
      return res.status(400).json({ error: 'Not a recognized export file' });
    }

    const summary = {
      pages: { matched: 0, inserted: 0 },
      sections: { matched: 0, inserted: 0 },
      variants: { matched: 0, inserted: 0 },
      links: { inserted: 0, skipped: 0 },
      redirects: { inserted: 0, skipped: 0 },
    };

    const run = db.transaction(() => {
      const pageMap = {};
      for (const p of data.pages || []) {
        const existing = db.prepare('SELECT id FROM pages WHERE name = ?').get(p.name);
        if (existing) {
          pageMap[p.id] = existing.id;
          summary.pages.matched++;
        } else {
          const info = db.prepare('INSERT INTO pages (name, created_by) VALUES (?, ?)').run(p.name, req.session.user.id);
          pageMap[p.id] = info.lastInsertRowid;
          summary.pages.inserted++;
        }
      }

      const sectionMap = {};
      for (const s of data.sections || []) {
        const pageId = pageMap[s.page_id];
        if (!pageId) continue;
        const existing = db.prepare('SELECT id FROM sections WHERE page_id = ? AND name = ?').get(pageId, s.name);
        if (existing) {
          sectionMap[s.id] = existing.id;
          summary.sections.matched++;
        } else {
          const info = db
            .prepare('INSERT INTO sections (page_id, name, created_by) VALUES (?, ?, ?)')
            .run(pageId, s.name, req.session.user.id);
          sectionMap[s.id] = info.lastInsertRowid;
          summary.sections.inserted++;
        }
      }

      const variantMap = {};
      for (const v of data.variants || []) {
        const sectionId = sectionMap[v.section_id];
        if (!sectionId) continue;
        const existing = db.prepare('SELECT id FROM variants WHERE section_id = ? AND name = ?').get(sectionId, v.name);
        if (existing) {
          variantMap[v.id] = existing.id;
          summary.variants.matched++;
        } else {
          const info = db
            .prepare('INSERT INTO variants (section_id, name, created_by) VALUES (?, ?, ?)')
            .run(sectionId, v.name, req.session.user.id);
          variantMap[v.id] = info.lastInsertRowid;
          summary.variants.inserted++;
        }
      }

      const linkMap = {};
      for (const l of data.links || []) {
        if (slugs.slugExists(l.slug)) {
          summary.links.skipped++;
          continue;
        }
        const pageId = pageMap[l.page_id];
        const sectionId = sectionMap[l.section_id];
        const variantId = variantMap[l.variant_id];
        if (!pageId || !sectionId || !variantId) {
          summary.links.skipped++;
          continue;
        }
        const info = db
          .prepare(
            `INSERT INTO links
               (slug, page_id, section_id, variant_id, label, storage_path, cdn_url, driver,
                original_name, mime, size, checksum, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            l.slug, pageId, sectionId, variantId, l.label, l.storage_path, l.cdn_url, l.driver,
            l.original_name, l.mime, l.size, l.checksum, req.session.user.id,
            l.created_at || new Date().toISOString(), l.updated_at || new Date().toISOString()
          );
        linkMap[l.id] = info.lastInsertRowid;
        summary.links.inserted++;
      }

      for (const r of data.redirects || []) {
        const newLinkId = linkMap[r.link_id];
        if (!newLinkId || slugs.slugExists(r.old_slug)) {
          summary.redirects.skipped++;
          continue;
        }
        db.prepare('INSERT INTO redirects (old_slug, link_id, created_at) VALUES (?, ?, ?)').run(
          r.old_slug, newLinkId, r.created_at || new Date().toISOString()
        );
        summary.redirects.inserted++;
      }
    });

    run();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

module.exports = router;
