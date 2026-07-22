'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const storageConfig = require('./storageConfig');

const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const d of [LOCAL_DIR, TMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---- S3 client (lazy; rebuilt if config changes) ----
let _s3 = { client: null, sig: null };
function s3Client(cfg) {
  const sig = JSON.stringify([cfg.endpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey, cfg.forcePathStyle]);
  if (_s3.client && _s3.sig === sig) return _s3.client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: !!cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  _s3 = { client, sig };
  return client;
}

function prefixed(prefix, key) {
  const clean = key.replace(/^\/+/, '');
  return prefix ? `${prefix}/${clean}` : clean;
}
function token() {
  return crypto.randomBytes(4).toString('hex');
}

/** SHA-256 of a file, only needed for drivers that verify integrity over the network. */
function digests(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => {
      const buf = hash.digest();
      resolve({ hex: buf.toString('hex').toUpperCase(), b64: buf.toString('base64') });
    });
  });
}

async function uploadLocal(key, tmpPath, size) {
  const skey = key.replace(/^\/+/, '');
  const dest = path.join(LOCAL_DIR, skey);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(fs.createReadStream(tmpPath), fs.createWriteStream(dest));
  return { driver: 'local', storagePath: skey, cdnUrl: `/files/${skey}`, checksum: null, size };
}

/**
 * Stream a temp file into storage using the given driver.
 * Local skips config resolution and checksum hashing entirely — neither is
 * needed when the bytes never leave the box.
 * @returns {Promise<{driver, storagePath, cdnUrl, checksum, size}>}
 */
async function uploadFile(key, tmpPath, mime, driver) {
  const size = (await fsp.stat(tmpPath)).size;

  if (driver === 'local') return uploadLocal(key, tmpPath, size);

  const cfg = storageConfig.resolve();
  const { hex, b64 } = await digests(tmpPath);

  if (driver === 'bunny') {
    if (!cfg.bunny.configured) throw new Error('Bunny storage not configured');
    const skey = prefixed(cfg.bunny.basePath, key);
    const res = await fetch(`https://${cfg.bunny.host}/${cfg.bunny.zone}/${skey}`, {
      method: 'PUT',
      headers: {
        AccessKey: cfg.bunny.key,
        'Content-Type': mime || 'application/octet-stream',
        'Content-Length': String(size),
        Checksum: hex,
      },
      body: Readable.toWeb(fs.createReadStream(tmpPath)),
      duplex: 'half',
    });
    if (!res.ok) throw new Error(`Bunny upload failed (${res.status}): ${await res.text().catch(() => '')}`);
    const cdnUrl = cfg.bunny.pullZone ? `https://${cfg.bunny.pullZone}/${skey}` : '';
    return { driver: 'bunny', storagePath: skey, cdnUrl, checksum: hex, size };
  }

  if (driver === 's3') {
    if (!cfg.s3.configured) throw new Error('S3 storage not configured');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const skey = prefixed(cfg.s3.prefix, key);
    await s3Client(cfg.s3).send(
      new PutObjectCommand({
        Bucket: cfg.s3.bucket,
        Key: skey,
        Body: fs.createReadStream(tmpPath),
        ContentType: mime || 'application/octet-stream',
        ContentLength: size,
        ChecksumSHA256: b64,
      })
    );
    const cdnUrl = cfg.s3.publicBaseUrl ? `${cfg.s3.publicBaseUrl}/${skey}` : '';
    return { driver: 's3', storagePath: skey, cdnUrl, checksum: hex, size };
  }

  throw new Error(`Unknown storage driver "${driver}"`);
}

/** Delete stored bytes. Best-effort — never throws. */
async function remove(storagePath, driver) {
  if (!storagePath) return;
  try {
    if (driver === 'local') {
      await fsp.unlink(path.join(LOCAL_DIR, storagePath)).catch(() => {});
      return;
    }
    const cfg = storageConfig.resolve();
    if (driver === 'bunny') {
      if (!cfg.bunny.configured) return;
      await fetch(`https://${cfg.bunny.host}/${cfg.bunny.zone}/${storagePath}`, {
        method: 'DELETE',
        headers: { AccessKey: cfg.bunny.key },
      });
    } else if (driver === 's3') {
      if (!cfg.s3.configured) return;
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3Client(cfg.s3).send(new DeleteObjectCommand({ Bucket: cfg.s3.bucket, Key: storagePath }));
    }
  } catch (_) {
    /* best-effort */
  }
}

/** Content-Disposition value that makes browsers download rather than render inline. */
function attachmentHeader(filename) {
  const name = String(filename || 'file');
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream stored bytes to an Express response (proxy download). */
async function streamTo(res, link) {
  res.setHeader('Content-Disposition', attachmentHeader(link.original_name));

  if (link.driver === 'local') {
    const abs = path.join(LOCAL_DIR, link.storage_path);
    if (!fs.existsSync(abs)) return res.status(404).send('File missing');
    if (link.mime) res.type(link.mime);
    return res.sendFile(abs);
  }

  const cfg = storageConfig.resolve();
  if (link.driver === 'bunny') {
    if (!cfg.bunny.configured) return res.status(502).send('Storage not configured');
    const upstream = await fetch(`https://${cfg.bunny.host}/${cfg.bunny.zone}/${link.storage_path}`, {
      headers: { AccessKey: cfg.bunny.key },
    });
    if (!upstream.ok || !upstream.body) return res.status(502).send('Upstream storage error');
    if (link.mime) res.type(link.mime);
    if (link.size) res.setHeader('Content-Length', String(link.size));
    return pipeline(Readable.fromWeb(upstream.body), res);
  }
  if (link.driver === 's3') {
    if (!cfg.s3.configured) return res.status(502).send('Storage not configured');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await s3Client(cfg.s3).send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: link.storage_path }));
    if (link.mime) res.type(link.mime);
    if (out.ContentLength) res.setHeader('Content-Length', String(out.ContentLength));
    return pipeline(out.Body, res);
  }
  res.status(500).send('Unknown storage driver');
}

/**
 * Public URL to redirect to, or null if the file must be proxied through the app.
 * S3 supports forcing a download via `response-content-disposition` on the GET —
 * Bunny's pull-zone CDN has no such query param; forcing a download there requires
 * an Edge Rule configured in the Bunny dashboard (Force Download action).
 */
function publicUrl(link) {
  if (link.driver === 'local') return null;
  const cfg = storageConfig.resolve();
  if (link.driver === 'bunny' && cfg.bunny.pullZone) return `https://${cfg.bunny.pullZone}/${link.storage_path}`;
  if (link.driver === 's3' && cfg.s3.publicBaseUrl) {
    const disposition = encodeURIComponent(attachmentHeader(link.original_name));
    return `${cfg.s3.publicBaseUrl}/${link.storage_path}?response-content-disposition=${disposition}`;
  }
  return null;
}

/** Is the given driver ready to accept uploads? */
function isConfigured(driver) {
  if (driver === 'local') return true;
  const cfg = storageConfig.resolve();
  if (driver === 'bunny') return cfg.bunny.configured;
  if (driver === 's3') return cfg.s3.configured;
  return false;
}

module.exports = { token, uploadFile, remove, streamTo, publicUrl, isConfigured, LOCAL_DIR, TMP_DIR };
