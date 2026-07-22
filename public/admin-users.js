'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const tbody = document.querySelector('#userTable tbody');
const createMsg = document.getElementById('createMsg');

async function load() {
  const users = await api('/api/admin/users');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(u.username)}</td>
      <td><span class="emailDisplay">${esc(u.email) || '<span class="muted small">none</span>'}</span>
        <span class="row hidden emailEdit" style="gap:.3rem">
          <input type="email" class="emailInput" value="${esc(u.email)}" style="max-width:180px" />
          <button class="btn small primary" data-act="saveEmail">Save</button>
        </span>
      </td>
      <td><span class="pill ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
      <td>${u.active ? 'active' : '<span class="pill off">disabled</span>'}</td>
      <td class="row wrap">
        <button class="btn small" data-act="editEmail">Edit email</button>
        <button class="btn small" data-act="toggle">${u.active ? 'Disable' : 'Enable'}</button>
        <button class="btn small" data-act="role">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
        <button class="btn small" data-act="pw">Reset pw</button>
      </td>`;

    const emailDisplay = tr.querySelector('.emailDisplay');
    const emailEdit = tr.querySelector('.emailEdit');
    const emailInput = tr.querySelector('.emailInput');
    tr.querySelector('[data-act="editEmail"]').onclick = () => { emailDisplay.classList.add('hidden'); emailEdit.classList.remove('hidden'); emailInput.focus(); };
    tr.querySelector('[data-act="saveEmail"]').onclick = () => patch(u.id, { email: emailInput.value.trim() });

    tr.querySelector('[data-act="toggle"]').onclick = () => patch(u.id, { active: !u.active });
    tr.querySelector('[data-act="role"]').onclick = () => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });

    // inline password-reset row (no window.prompt — unreliable in some browsers)
    const pwBtn = tr.querySelector('[data-act="pw"]');
    pwBtn.onclick = () => {
      if (tr.querySelector('.pwRow')) return;
      const row = document.createElement('tr');
      row.className = 'pwRow';
      row.innerHTML = `<td colspan="5"><div class="row wrap" style="padding:.4rem 0">
        <input type="password" class="newPw" placeholder="new password (min 8)" style="max-width:220px" />
        <button class="btn small primary" data-act="confirmPw">Set password</button>
        <button class="btn small" data-act="cancelPw">Cancel</button>
      </div></td>`;
      tr.after(row);
      row.querySelector('.newPw').focus();
      row.querySelector('[data-act="cancelPw"]').onclick = () => row.remove();
      row.querySelector('[data-act="confirmPw"]').onclick = () => {
        const p = row.querySelector('.newPw').value;
        if (p) patch(u.id, { password: p });
      };
    };

    tbody.appendChild(tr);
  }
}

async function patch(id, body) {
  try { await api(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await load(); }
  catch (e) { createMsg.textContent = e.message; createMsg.className = 'msg err'; }
}

document.getElementById('createUserForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  createMsg.textContent = '';
  try {
    await api('/api/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), email: fd.get('email'), password: fd.get('password'), role: fd.get('role') }),
    });
    ev.target.reset();
    createMsg.textContent = 'Created.'; createMsg.className = 'msg ok';
    await load();
  } catch (e) { createMsg.textContent = e.message; createMsg.className = 'msg err'; }
});

load().catch((e) => { createMsg.textContent = e.message; });
