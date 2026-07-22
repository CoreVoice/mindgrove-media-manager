'use strict';

const express = require('express');
const db = require('../db');
const storage = require('../storage');

const router = express.Router();

// GET /f/:slug  -> serve the current file for a link. Old (renamed) slugs
// forward to the link's current slug, so a handed-out link is never dead.
router.get('/f/:slug', async (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE slug = ?').get(req.params.slug);
  if (!link) {
    const redirect = db
      .prepare(
        `SELECT l.slug FROM redirects r JOIN links l ON l.id = r.link_id WHERE r.old_slug = ?`
      )
      .get(req.params.slug);
    if (redirect) return res.redirect(301, `/f/${redirect.slug}`);
    return res.status(404).send('Not found');
  }

  const url = storage.publicUrl(link);
  if (url) return res.redirect(302, url); // pull-zone / CDN path
  await storage.streamTo(res, link); // proxy fallback (local / no pull zone)
});

module.exports = router;
