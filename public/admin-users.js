'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const tbody = document.querySelector('#userTable tbody');
const createMsg = document.getElementById('createMsg');

async function load() {
  const users = await api('/api/admin/users');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(u.username)}</td>
      <td><span class="pill ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
      <td>${u.active ? 'active' : '<span class="pill off">disabled</span>'}</td>
      <td class="row">
        <button class="btn small" data-act="toggle">${u.active ? 'Disable' : 'Enable'}</button>
        <button class="btn small" data-act="role">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
        <button class="btn small" data-act="pw">Reset pw</button>
      </td>`;
    tr.querySelector('[data-act="toggle"]').onclick = () => patch(u.id, { active: !u.active });
    tr.querySelector('[data-act="role"]').onclick = () => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    tr.querySelector('[data-act="pw"]').onclick = () => {
      const p = prompt(`New password for ${u.username} (min 8):`);
      if (p) patch(u.id, { password: p });
    };
    tbody.appendChild(tr);
  }
}

async function patch(id, body) {
  try { await api(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await load(); }
  catch (e) { alert(e.message); }
}

document.getElementById('createUserForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  createMsg.textContent = '';
  try {
    await api('/api/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password'), role: fd.get('role') }),
    });
    ev.target.reset();
    createMsg.textContent = 'Created.'; createMsg.className = 'msg ok';
    await load();
  } catch (e) { createMsg.textContent = e.message; createMsg.className = 'msg err'; }
});

load().catch((e) => { createMsg.textContent = e.message; });
