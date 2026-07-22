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

async function load() {
  const v = await api('/api/admin/mail-settings');
  $('host').value = v.host || '';
  $('port').value = v.port || '';
  $('secure').checked = !!v.secure;
  $('fromAddress').value = v.fromAddress || '';
  $('notifyTo').value = v.notifyTo || '';
  if (v.userSet) $('smtpUser').placeholder = '•••• set — leave blank to keep';
  if (v.passSet) $('smtpPass').placeholder = '•••• set — leave blank to keep';
  statusEl.textContent = v.configured ? 'Configured ✓ — ready to send.' : 'Not fully configured yet (needs host, username, password, and from address).';
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  msg.textContent = ''; msg.className = 'msg';
  const body = {
    host: $('host').value.trim(), port: $('port').value.trim(), secure: $('secure').checked,
    fromAddress: $('fromAddress').value.trim(), notifyTo: $('notifyTo').value.trim(),
  };
  if ($('smtpUser').value) body.smtpUser = $('smtpUser').value;
  if ($('smtpPass').value) body.smtpPass = $('smtpPass').value;
  try {
    await api('/api/admin/mail-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    msg.textContent = 'Saved.'; msg.className = 'msg ok';
    $('smtpUser').value = ''; $('smtpPass').value = '';
    await load();
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
});

document.getElementById('testBtn').addEventListener('click', async () => {
  const to = document.getElementById('testTo').value.trim();
  const testMsg = document.getElementById('testMsg');
  if (!to) { testMsg.textContent = 'Enter an address first.'; testMsg.className = 'msg err'; return; }
  testMsg.textContent = 'Sending…'; testMsg.className = 'msg';
  try {
    await api('/api/admin/mail-settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
    testMsg.textContent = 'Sent — check the inbox.'; testMsg.className = 'msg ok';
  } catch (e) { testMsg.textContent = e.message; testMsg.className = 'msg err'; }
});

load().catch((e) => { statusEl.textContent = e.message; });
