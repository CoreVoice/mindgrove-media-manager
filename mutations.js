'use strict';

// Pure data mutations, no auth/HTTP concerns. Called two ways:
//   - directly, when an admin makes a change (applies immediately)
//   - by the approval flow, when an admin approves a queued user change
// Keeping them here guarantees both paths behave identically.

const db = require('./db');
const storage = require('./storage');

/** Duplicate guard: same filename + same checksum already in this variant slot. */
function duplicateInVariant(variantId, originalName, checksum) {
  if (!checksum) return false;
  return !!db
    .prepare('SELECT 1 FROM links WHERE variant_id = ? AND original_name = ? AND checksum = ?')
    .get(variantId, originalName, checksum);
}

/** Insert a live link row from an upload result. Returns the new link id. */
function insertLink({ slug, pageId, sectionId, variantId, label, up, mime, originalName, byUserId }) {
  const info = db
    .prepare(
      `INSERT INTO links
         (slug, page_id, section_id, variant_id, label, storage_path, cdn_url, driver,
          original_name, mime, size, checksum, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(slug, pageId, sectionId, variantId, label, up.storagePath, up.cdnUrl, up.driver, originalName, mime, up.size, up.checksum, byUserId);
  return info.lastInsertRowid;
}

/** Point a link at new bytes, drop the old bytes (best-effort). */
async function replaceFile(link, up, originalName, mime) {
  const oldPath = link.storage_path;
  const oldDriver = link.driver;
  db.prepare(
    `UPDATE links SET label = ?, storage_path = ?, cdn_url = ?, driver = ?, original_name = ?,
       mime = ?, size = ?, checksum = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(originalName, up.storagePath, up.cdnUrl, up.driver, originalName, mime, up.size, up.checksum, link.id);
  await storage.remove(oldPath, oldDriver);
}

/** Change a slug, preserving the old one as a redirect. Assumes uniqueness already checked. */
function renameSlug(link, newSlug) {
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO redirects (old_slug, link_id) VALUES (?, ?)').run(link.slug, link.id);
    db.prepare('UPDATE links SET slug = ? WHERE id = ?').run(newSlug, link.id);
  });
  tx();
}

/** Delete a link and its stored bytes (best-effort). */
async function deleteLink(link) {
  await storage.remove(link.storage_path, link.driver);
  db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
}

// ---- tags ----
function ensureTag(name, byUserId) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO tags (name, created_by) VALUES (?, ?)').run(clean, byUserId).lastInsertRowid;
}

/** Resolve a mix of existing tag ids and new tag names to a list of tag ids. */
function resolveTagIds({ tagIds = [], newNames = [] }, byUserId) {
  const ids = new Set();
  for (const id of tagIds) {
    if (db.prepare('SELECT 1 FROM tags WHERE id = ?').get(id)) ids.add(Number(id));
  }
  for (const name of newNames) {
    const id = ensureTag(name, byUserId);
    if (id) ids.add(Number(id));
  }
  return [...ids];
}

/** Replace a link's tag set. */
function setTags(linkId, tagIds) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM link_tags WHERE link_id = ?').run(linkId);
    const ins = db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag_id) VALUES (?, ?)');
    for (const tid of tagIds) ins.run(linkId, tid);
  });
  tx();
}

function tagsFor(linkId) {
  return db
    .prepare('SELECT t.id, t.name FROM link_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.link_id = ? ORDER BY t.name')
    .all(linkId);
}

module.exports = {
  duplicateInVariant,
  insertLink,
  replaceFile,
  renameSlug,
  deleteLink,
  ensureTag,
  resolveTagIds,
  setTags,
  tagsFor,
};
