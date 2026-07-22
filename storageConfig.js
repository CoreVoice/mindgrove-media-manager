'use strict';

const settings = require('./settings');
const { encrypt, decrypt } = require('./crypto');

const CFG_KEY = 'storage_config';
const SEC = {
  bunnyAccessKey: 'sec_bunny_access_key',
  s3AccessKeyId: 'sec_s3_access_key_id',
  s3SecretAccessKey: 'sec_s3_secret_access_key',
};

function readJson() {
  try {
    return JSON.parse(settings.get(CFG_KEY, '') || '{}');
  } catch (_) {
    return {};
  }
}

const pick = (v, envVal) => (v !== undefined && v !== null && v !== '' ? v : envVal || '');
const bool = (v, envVal) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return String(envVal || '').toLowerCase() === 'true';
};

/** Effective config used by the server (secrets decrypted, env as fallback). */
function resolve() {
  const c = readJson();
  const b = c.bunny || {};
  const s = c.s3 || {};

  const driverRaw = c.driver || (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  const driver = ['local', 'bunny', 's3'].includes(driverRaw) ? driverRaw : 'local';

  const bunny = {
    zone: pick(b.zone, process.env.BUNNY_STORAGE_ZONE),
    key: decrypt(settings.get(SEC.bunnyAccessKey)) || process.env.BUNNY_STORAGE_ACCESS_KEY || '',
    host: pick(b.host, process.env.BUNNY_STORAGE_HOST) || 'storage.bunnycdn.com',
    pullZone: pick(b.pullZone, process.env.BUNNY_PULL_ZONE_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    basePath: pick(b.basePath, process.env.BUNNY_BASE_PATH).replace(/^\/+|\/+$/g, ''),
  };
  bunny.configured = !!(bunny.zone && bunny.key);
  bunny.hasPullZone = !!bunny.pullZone;

  const s3 = {
    endpoint: pick(s.endpoint, process.env.S3_ENDPOINT),
    region: pick(s.region, process.env.S3_REGION) || 'auto',
    bucket: pick(s.bucket, process.env.S3_BUCKET),
    accessKeyId: decrypt(settings.get(SEC.s3AccessKeyId)) || process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: decrypt(settings.get(SEC.s3SecretAccessKey)) || process.env.S3_SECRET_ACCESS_KEY || '',
    publicBaseUrl: pick(s.publicBaseUrl, process.env.S3_PUBLIC_BASE_URL).replace(/\/+$/, ''),
    prefix: pick(s.prefix, process.env.S3_PREFIX).replace(/^\/+|\/+$/g, ''),
    forcePathStyle: bool(s.forcePathStyle, process.env.S3_FORCE_PATH_STYLE),
  };
  s3.configured = !!(s3.bucket && s3.accessKeyId && s3.secretAccessKey);

  return { driver, bunny, s3 };
}

/** Safe view for the browser — no secret values, only "set" flags. */
function publicView() {
  const c = resolve();
  return {
    driver: c.driver,
    configured: { local: true, bunny: c.bunny.configured, s3: c.s3.configured },
    bunny: {
      zone: c.bunny.zone,
      host: c.bunny.host,
      pullZone: c.bunny.pullZone,
      basePath: c.bunny.basePath,
      accessKeySet: !!c.bunny.key,
      hasPullZone: c.bunny.hasPullZone,
    },
    s3: {
      endpoint: c.s3.endpoint,
      region: c.s3.region,
      bucket: c.s3.bucket,
      publicBaseUrl: c.s3.publicBaseUrl,
      prefix: c.s3.prefix,
      forcePathStyle: c.s3.forcePathStyle,
      accessKeyIdSet: !!c.s3.accessKeyId,
      secretAccessKeySet: !!c.s3.secretAccessKey,
      publicBaseSet: !!c.s3.publicBaseUrl,
    },
  };
}

/**
 * Merge & persist admin-submitted config. Secret fields: non-empty = store (encrypted),
 * empty/undefined = keep existing. Returns the effective resolved config.
 */
function update(input = {}) {
  const cur = readJson();
  const next = {
    driver: input.driver || cur.driver,
    bunny: { ...(cur.bunny || {}) },
    s3: { ...(cur.s3 || {}) },
  };

  const b = input.bunny || {};
  for (const f of ['zone', 'host', 'pullZone', 'basePath']) if (b[f] !== undefined) next.bunny[f] = b[f];
  if (b.accessKey) settings.set(SEC.bunnyAccessKey, encrypt(b.accessKey));

  const s = input.s3 || {};
  for (const f of ['endpoint', 'region', 'bucket', 'publicBaseUrl', 'prefix']) if (s[f] !== undefined) next.s3[f] = s[f];
  if (s.forcePathStyle !== undefined) next.s3.forcePathStyle = !!s.forcePathStyle;
  if (s.accessKeyId) settings.set(SEC.s3AccessKeyId, encrypt(s.accessKeyId));
  if (s.secretAccessKey) settings.set(SEC.s3SecretAccessKey, encrypt(s.secretAccessKey));

  settings.set(CFG_KEY, JSON.stringify(next));
  return resolve();
}

module.exports = { resolve, publicView, update };
