'use strict';

const express = require('express');
const audit = require('../audit');
const { requireAdmin } = require('../auth');

const router = express.Router();

router.get('/audit', requireAdmin, (req, res) => {
  const { rows, total, actions } = audit.list({
    limit: req.query.limit, offset: req.query.offset, action: req.query.action || null,
  });
  res.json({ rows, total, actions });
});

module.exports = router;
