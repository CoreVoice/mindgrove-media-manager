'use strict';

// The approval queue. api.js enqueues user changes here; the approvals route
// approves (apply via mutations) or rejects (discard staged bytes) them.

const db = require('./db');
const storage = require('./storage');
const slugs = require('./slug');
const M = require('./mutations');
const audit = require('./audit');
const mailer = require('./mailer');
const notifications = require('./notifications');

/** Enqueue a pending change. `staged` = { path, driver } for create/replace bytes. */
function queue(kind, { linkId = null, payload = {}, staged = null, byUserId }) {
  const info = db
    .prepare(
      `INSERT INTO change_requests (kind, link_id, payload, staged_path, staged_driver, requested_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(kind, linkId, JSON.stringify(payload), staged ? staged.path : null, staged ? staged.driver : null, byUserId);
  const id = info.lastInsertRowid;

  const requester = db.prepare('SELECT username FROM users WHERE id = ?').get(byUserId);
  audit.log(byUserId, 'change.request', { entityType: 'change_request', entityId: id, summary: `Requested: ${kind} (awaiting approval)` });
  mailer.notifyAdminPending({ kind, payload, requestedByUsername: requester ? requester.username : 'someone' }).catch(() => {});

  return id;
}

/** Pending change (if any) against a given live link — for the "review pending" badge. */
function pendingForLink(linkId) {
  const r = db
    .prepare(
      `SELECT cr.id, cr.kind, u.username AS by
         FROM change_requests cr LEFT JOIN users u ON u.id = cr.requested_by
        WHERE cr.link_id = ? AND cr.status = 'pending' ORDER BY cr.id LIMIT 1`
    )
    .get(linkId);
  return r || null;
}

/** Pending NEW-upload requests for a variant. Admins see all; users see their own. */
function pendingCreatesForVariant(variantId, user) {
  const rows = db
    .prepare(
      `SELECT cr.id, cr.payload, cr.requested_at, u.username AS requestedBy, cr.requested_by
         FROM change_requests cr LEFT JOIN users u ON u.id = cr.requested_by
        WHERE cr.kind = 'create' AND cr.status = 'pending'
        ORDER BY cr.id DESC`
    )
    .all();
  return rows
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
    .filter((r) => r.payload.variantId === Number(variantId))
    .filter((r) => user.role === 'admin' || r.requested_by === user.id);
}

/** Full pending list for the admin Approvals screen. */
function listPending() {
  return db
    .prepare(
      `SELECT cr.id, cr.kind, cr.link_id, cr.payload, cr.requested_at,
              u.username AS requestedBy, l.slug AS linkSlug, l.label AS linkLabel
         FROM change_requests cr
         LEFT JOIN users u ON u.id = cr.requested_by
         LEFT JOIN links l ON l.id = cr.link_id
        WHERE cr.status = 'pending'
        ORDER BY cr.id ASC`
    )
    .all()
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM change_requests WHERE status = 'pending'").get().n;
}

function markReviewed(id, status, adminId, note) {
  db.prepare("UPDATE change_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), note = ? WHERE id = ?")
    .run(status, adminId, note || null, id);
}

function requesterEmail(userId) {
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  return u ? u.email : null;
}

/** Apply a pending change. Throws (with a user-facing message) if no longer valid. */
async function approve(id, adminId) {
  const cr = db.prepare("SELECT * FROM change_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!cr) throw new Error('Request not found or already reviewed');
  const p = JSON.parse(cr.payload);

  let nav = { pageId: p.pageId, sectionId: p.sectionId, variantId: p.variantId };

  if (cr.kind === 'create') {
    if (slugs.slugExists(p.slug)) throw new Error(`Slug "${p.slug}" was taken since this was requested`);
    M.insertLink({
      slug: p.slug, pageId: p.pageId, sectionId: p.sectionId, variantId: p.variantId,
      label: p.label, up: p.up, mime: p.mime, originalName: p.originalName, byUserId: cr.requested_by,
    });
    const newLink = db.prepare('SELECT id FROM links WHERE slug = ?').get(p.slug);
    if (p.tagIds && p.tagIds.length) M.setTags(newLink.id, M.resolveTagIds({ tagIds: p.tagIds }, cr.requested_by), cr.requested_by);
    nav.linkId = newLink.id;
  } else {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(cr.link_id);
    if (!link) throw new Error('The target file no longer exists');
    nav = { pageId: link.page_id, sectionId: link.section_id, variantId: link.variant_id, linkId: link.id };

    if (cr.kind === 'replace') {
      await M.replaceFile(link, p.up, p.originalName, p.mime, cr.requested_by);
    } else if (cr.kind === 'slug') {
      if (p.slug !== link.slug && slugs.slugExists(p.slug)) throw new Error(`Slug "${p.slug}" is already taken`);
      if (p.slug !== link.slug) M.renameSlug(link, p.slug, cr.requested_by);
    } else if (cr.kind === 'delete') {
      await M.deleteLink(link, cr.requested_by);
      nav.linkId = null; // the file is gone; still land on its variant slot
    } else if (cr.kind === 'tags') {
      M.setTags(link.id, M.resolveTagIds({ tagIds: p.tagIds || [], newNames: p.newNames || [] }, cr.requested_by), cr.requested_by);
    } else {
      throw new Error(`Unknown change kind "${cr.kind}"`);
    }
  }

  markReviewed(cr.id, 'approved', adminId);
  audit.log(adminId, 'change.approve', { entityType: 'change_request', entityId: cr.id, summary: `Approved ${cr.kind} request` });
  notifications.create(cr.requested_by, `Approved: ${mailer.describeChange(cr.kind, p)}`, nav);
  mailer.notifyUserReviewed({ toEmail: requesterEmail(cr.requested_by), kind: cr.kind, payload: p, status: 'approved' }).catch(() => {});
  return { kind: cr.kind };
}

/** Reject a pending change and discard any staged bytes. */
async function reject(id, adminId, note) {
  const cr = db.prepare("SELECT * FROM change_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!cr) throw new Error('Request not found or already reviewed');
  const p = JSON.parse(cr.payload);
  if (cr.staged_path) await storage.remove(cr.staged_path, cr.staged_driver);
  markReviewed(cr.id, 'rejected', adminId, note);
  audit.log(adminId, 'change.reject', { entityType: 'change_request', entityId: cr.id, summary: `Rejected ${cr.kind} request` });

  let nav = { pageId: p.pageId, sectionId: p.sectionId, variantId: p.variantId };
  if (cr.kind !== 'create') {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(cr.link_id);
    if (link) nav = { pageId: link.page_id, sectionId: link.section_id, variantId: link.variant_id, linkId: link.id };
  }
  notifications.create(cr.requested_by, `Rejected: ${mailer.describeChange(cr.kind, p)}${note ? ` — ${note}` : ''}`, nav);
  mailer.notifyUserReviewed({ toEmail: requesterEmail(cr.requested_by), kind: cr.kind, payload: p, status: 'rejected', note }).catch(() => {});
  return { kind: cr.kind };
}

module.exports = {
  queue,
  pendingForLink,
  pendingCreatesForVariant,
  listPending,
  pendingCount,
  approve,
  reject,
};
