'use strict';

const db = require('./db');

/** Create an in-dashboard notification. nav = { pageId, sectionId, variantId, linkId }. */
function create(userId, message, nav = {}) {
  db.prepare(
    `INSERT INTO notifications (user_id, message, page_id, section_id, variant_id, link_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, message, nav.pageId || null, nav.sectionId || null, nav.variantId || null, nav.linkId || null);
}

function listForUser(userId, { limit = 20 } = {}) {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Math.max(Number(limit) || 20, 1), 100));
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;
}

function markRead(id, userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

function markAllRead(userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
}

module.exports = { create, listForUser, unreadCount, markRead, markAllRead };
