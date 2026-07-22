'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
const $ = (n) => document.querySelector(`[name="${n}"]`);
const msg = document.getElementById('msg');
const statusEl = document.getElementById('status');

function radios() { return [...document.querySelectorAll('input[name="driver"]')]; }
function selected() { return (radios().find((r) => r.checked) || {}).value; }

function toggleGroups() {
  document.getElementById('bunnyFields').classList.toggle('hidden', selected() !== 'bunny');
  document.getElementById('s3Fields').classList.toggle('hidden', selected() !== 's3');
}
radios().forEach((r) => r.addEventListener('change', toggleGroups));

function renderStatus(v) {
  const parts = [`Local: ready`];
  parts.push(`Bunny: ${v.configured.bunny ? 'configured ✓' + (v.bunny.hasPullZone ? ' · pull zone ✓' : ' · ⚠ no pull zone (proxy)') : 'not configured'}`);
  parts.push(`S3: ${v.configured.s3 ? 'configured ✓' + (v.s3.publicBaseSet ? ' · public URL ✓' : ' · ⚠ no public URL (proxy)') : 'not configured'}`);
  statusEl.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

async function load() {
  const v = await api('/api/admin/settings');
  radios().forEach((r) => { r.checked = r.value === v.driver; });

  // Bunny (non-secret fields prefilled; secrets shown as "set" via placeholder)
  $('b_zone').value = v.bunny.zone || '';
  $('b_host').value = v.bunny.host || '';
  $('b_pull').value = v.bunny.pullZone || '';
  $('b_base').value = v.bunny.basePath || '';
  if (v.bunny.accessKeySet) $('b_key').placeholder = '•••• set — leave blank to keep';

  // S3
  $('s_endpoint').value = v.s3.endpoint || '';
  $('s_region').value = v.s3.region || '';
  $('s_bucket').value = v.s3.bucket || '';
  $('s_public').value = v.s3.publicBaseUrl || '';
  $('s_prefix').value = v.s3.prefix || '';
  $('s_pathstyle').checked = !!v.s3.forcePathStyle;
  if (v.s3.accessKeyIdSet) $('s_keyid').placeholder = '•••• set — leave blank to keep';
  if (v.s3.secretAccessKeySet) $('s_secret').placeholder = '•••• set — leave blank to keep';

  toggleGroups();
  renderStatus(v);
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  msg.textContent = ''; msg.className = 'msg';
  const body = {
    driver: selected(),
    bunny: { zone: $('b_zone').value.trim(), host: $('b_host').value.trim(), pullZone: $('b_pull').value.trim(), basePath: $('b_base').value.trim() },
    s3: {
      endpoint: $('s_endpoint').value.trim(), region: $('s_region').value.trim(), bucket: $('s_bucket').value.trim(),
      publicBaseUrl: $('s_public').value.trim(), prefix: $('s_prefix').value.trim(), forcePathStyle: $('s_pathstyle').checked,
    },
  };
  // only send secrets if the admin actually typed them (blank = keep existing)
  if ($('b_key').value) body.bunny.accessKey = $('b_key').value;
  if ($('s_keyid').value) body.s3.accessKeyId = $('s_keyid').value;
  if ($('s_secret').value) body.s3.secretAccessKey = $('s_secret').value;

  try {
    const r = await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    msg.textContent = `Saved — new uploads go to ${body.driver}.`; msg.className = 'msg ok';
    ['b_key', 's_keyid', 's_secret'].forEach((n) => { $(n).value = ''; });
    renderStatus(r);
    await load();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
});

load().catch((e) => { statusEl.textContent = e.message; });
