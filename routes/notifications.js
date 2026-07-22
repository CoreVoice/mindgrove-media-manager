'use strict';

const express = require('express');
const notifications = require('../notifications');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/notifications', requireAuth, (req, res) => {
  res.json({
    items: notifications.listForUser(req.session.user.id),
    unread: notifications.unreadCount(req.session.user.id),
  });
});

router.get('/notifications/unread-count', requireAuth, (req, res) => {
  res.json({ unread: notifications.unreadCount(req.session.user.id) });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  notifications.markRead(Number(req.params.id), req.session.user.id);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  notifications.markAllRead(req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
