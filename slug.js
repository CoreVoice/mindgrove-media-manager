'use strict';

const crypto = require('crypto');
const db = require('./db');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/; // 3-64 chars, starts alphanumeric

function generateSlug(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function normalizeSlug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isValidSlug(slug) {
  return SLUG_RE.test(slug);
}

/** True if the slug is live OR reserved as a redirect for some other link. */
function slugExists(slug) {
  return (
    !!db.prepare('SELECT 1 FROM links WHERE slug = ?').get(slug) ||
    !!db.prepare('SELECT 1 FROM redirects WHERE old_slug = ?').get(slug)
  );
}

/** Generate a random slug guaranteed unique against the links table. */
function uniqueSlug() {
  let slug;
  let tries = 0;
  do {
    slug = generateSlug(tries < 5 ? 8 : 10);
    tries++;
  } while (slugExists(slug) && tries < 20);
  if (slugExists(slug)) throw new Error('Could not generate a unique slug');
  return slug;
}

module.exports = { generateSlug, normalizeSlug, isValidSlug, slugExists, uniqueSlug, SLUG_RE };
