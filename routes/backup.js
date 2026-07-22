'use strict';

// Export/import of the "link map" (taxonomy + links + redirects) bundled together
// with the actual file bytes, as a single .zip — one artifact, restorable anywhere.
//
// Deliberately excludes users (password hashes), sessions, and settings (encrypted
// storage credentials). This is a portable log of every short URL ever issued, what
// it points to, and (for local-driver files) the bytes themselves — not a full db backup.
//
// Bunny/S3-driven files are NOT bundled: their bytes already live on that storage,
// independent of this app's disk, so there's nothing to duplicate.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const AdmZip = require('adm-zip');
const db = require('../db');
const slugs = require('../slug');
const storage = require('../storage');
const { requireAdmin } = require('../auth');

const router = express.Router();
// Backup archives can be much bigger than a single upload — separate, larger limit.
const MAX_BACKUP_MB = Number(process.env.MAX_BACKUP_MB || 1024);
const upload = multer({ dest: storage.TMP_DIR, limits: { fileSize: MAX_BACKUP_MB * 1024 * 1024 } });

const EXPORT_VERSION = 2;

function buildManifest() {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    note: 'Taxonomy + link/slug map, bundled with local-driver file bytes under files/. No users, sessions, or storage credentials.',
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
}

router.get('/export', requireAdmin, (req, res) => {
  const manifest = buildManifest();
  const zip = new AdmZip();

  let bundled = 0;
  const missing = [];
  for (const link of manifest.links) {
    if (link.driver !== 'local') continue;
    const abs = path.join(storage.LOCAL_DIR, link.storage_path);
    if (fs.existsSync(abs)) {
      zip.addLocalFile(abs, path.dirname(path.join('files', link.storage_path)));
      bundled++;
    } else {
      missing.push(link.storage_path);
    }
  }
  manifest.localFilesBundled = bundled;
  manifest.localFilesMissing = missing;

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

  const stamp = manifest.exportedAt.slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="mindgrove-export-${stamp}.zip"`);
  res.send(zip.toBuffer());
});

function isZip(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(2);
  fs.readSync(fd, buf, 0, 2, 0);
  fs.closeSync(fd);
  return buf[0] === 0x50 && buf[1] === 0x4b; // 'PK'
}

/** Merge manifest data into the db. Never overwrites an existing slug/redirect. */
function importManifest(data, adminId) {
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
      if (existing) { pageMap[p.id] = existing.id; summary.pages.matched++; }
      else {
        const info = db.prepare('INSERT INTO pages (name, created_by) VALUES (?, ?)').run(p.name, adminId);
        pageMap[p.id] = info.lastInsertRowid; summary.pages.inserted++;
      }
    }

    const sectionMap = {};
    for (const s of data.sections || []) {
      const pageId = pageMap[s.page_id];
      if (!pageId) continue;
      const existing = db.prepare('SELECT id FROM sections WHERE page_id = ? AND name = ?').get(pageId, s.name);
      if (existing) { sectionMap[s.id] = existing.id; summary.sections.matched++; }
      else {
        const info = db.prepare('INSERT INTO sections (page_id, name, created_by) VALUES (?, ?, ?)').run(pageId, s.name, adminId);
        sectionMap[s.id] = info.lastInsertRowid; summary.sections.inserted++;
      }
    }

    const variantMap = {};
    for (const v of data.variants || []) {
      const sectionId = sectionMap[v.section_id];
      if (!sectionId) continue;
      const existing = db.prepare('SELECT id FROM variants WHERE section_id = ? AND name = ?').get(sectionId, v.name);
      if (existing) { variantMap[v.id] = existing.id; summary.variants.matched++; }
      else {
        const info = db.prepare('INSERT INTO variants (section_id, name, created_by) VALUES (?, ?, ?)').run(sectionId, v.name, adminId);
        variantMap[v.id] = info.lastInsertRowid; summary.variants.inserted++;
      }
    }

    const linkMap = {};
    for (const l of data.links || []) {
      if (slugs.slugExists(l.slug)) { summary.links.skipped++; continue; }
      const pageId = pageMap[l.page_id], sectionId = sectionMap[l.section_id], variantId = variantMap[l.variant_id];
      if (!pageId || !sectionId || !variantId) { summary.links.skipped++; continue; }
      const info = db
        .prepare(
          `INSERT INTO links
             (slug, page_id, section_id, variant_id, label, storage_path, cdn_url, driver,
              original_name, mime, size, checksum, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          l.slug, pageId, sectionId, variantId, l.label, l.storage_path, l.cdn_url, l.driver,
          l.original_name, l.mime, l.size, l.checksum, adminId,
          l.created_at || new Date().toISOString(), l.updated_at || new Date().toISOString()
        );
      linkMap[l.id] = info.lastInsertRowid; summary.links.inserted++;
    }

    for (const r of data.redirects || []) {
      const newLinkId = linkMap[r.link_id];
      if (!newLinkId || slugs.slugExists(r.old_slug)) { summary.redirects.skipped++; continue; }
      db.prepare('INSERT INTO redirects (old_slug, link_id, created_at) VALUES (?, ?, ?)').run(
        r.old_slug, newLinkId, r.created_at || new Date().toISOString()
      );
      summary.redirects.inserted++;
    }
  });

  run();
  return summary;
}

// POST /api/admin/import (multipart: file = exported .zip or legacy .json)
router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    let manifest;
    let filesRestored = 0;

    if (isZip(req.file.path)) {
      const zip = new AdmZip(req.file.path);
      const manifestEntry = zip.getEntry('manifest.json');
      if (!manifestEntry) return res.status(400).json({ error: 'Zip has no manifest.json — not a recognized export' });
      try {
        manifest = JSON.parse(zip.readAsText(manifestEntry));
      } catch (_) {
        return res.status(400).json({ error: 'manifest.json is not valid JSON' });
      }

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.startsWith('files/')) continue;
        const rel = entry.entryName.slice('files/'.length);
        const dest = path.join(storage.LOCAL_DIR, rel);
        if (fs.existsSync(dest)) continue; // never overwrite bytes already on disk
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, entry.getData());
        filesRestored++;
      }
    } else {
      const raw = await fsp.readFile(req.file.path, 'utf8');
      try {
        manifest = JSON.parse(raw);
      } catch (_) {
        return res.status(400).json({ error: 'Not a valid .zip export or .json export' });
      }
    }

    if (!manifest || !Array.isArray(manifest.links)) {
      return res.status(400).json({ error: 'Not a recognized export file' });
    }

    const summary = importManifest(manifest, req.session.user.id);
    res.json({ ok: true, summary, filesRestored });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    await fsp.unlink(req.file.path).catch(() => {});
  }
});

module.exports = router;
