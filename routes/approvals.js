'use strict';

const express = require('express');
const CR = require('../changeRequests');
const { requireAdmin } = require('../auth');

const router = express.Router();

const KIND_LABEL = {
  create: 'New upload',
  replace: 'Replace file',
  slug: 'Change short link',
  delete: 'Delete file',
  tags: 'Change tags',
};

function describe(cr) {
  const p = cr.payload || {};
  switch (cr.kind) {
    case 'create':
      return `Upload "${p.label}" → /f/${p.slug}`;
    case 'replace':
      return `Replace "${cr.linkLabel || cr.link_id}" with "${p.originalName}"`;
    case 'slug':
      return `Rename /f/${cr.linkSlug} → /f/${p.slug}`;
    case 'delete':
      return `Delete "${cr.linkLabel}" (/f/${cr.linkSlug})`;
    case 'tags':
      return `Set tags on "${cr.linkLabel}"`;
    default:
      return cr.kind;
  }
}

router.get('/approvals', requireAdmin, (req, res) => {
  const items = CR.listPending().map((cr) => ({
    id: cr.id,
    kind: cr.kind,
    kindLabel: KIND_LABEL[cr.kind] || cr.kind,
    description: describe(cr),
    requestedBy: cr.requestedBy,
    requestedAt: cr.requested_at,
  }));
  res.json({ items, count: items.length });
});

router.post('/approvals/:id/approve', requireAdmin, async (req, res) => {
  try {
    const r = await CR.approve(Number(req.params.id), req.session.user.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/approvals/:id/reject', requireAdmin, async (req, res) => {
  try {
    const r = await CR.reject(Number(req.params.id), req.session.user.id, req.body && req.body.note);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
