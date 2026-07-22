'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
function esc(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const tbody = document.querySelector('#approvalsTable tbody');
const table = document.getElementById('approvalsTable');
const empty = document.getElementById('emptyState');
const msg = document.getElementById('msg');

async function load() {
  const { items } = await api('/api/admin/approvals');
  tbody.innerHTML = '';
  table.classList.toggle('hidden', items.length === 0);
  empty.classList.toggle('hidden', items.length !== 0);
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="tag">${esc(it.kindLabel)}</span></td>
      <td>${esc(it.description)}</td>
      <td>${esc(it.requestedBy)}</td>
      <td class="muted small">${esc(it.requestedAt)}</td>
      <td class="row">
        <button class="btn small primary" data-act="approve">Approve</button>
        <button class="btn small danger" data-act="reject">Reject</button>
      </td>`;
    tr.querySelector('[data-act="approve"]').onclick = () => act(it.id, 'approve', tr);
    tr.querySelector('[data-act="reject"]').onclick = () => act(it.id, 'reject', tr);
    tbody.appendChild(tr);
  }
}

async function act(id, what, tr) {
  tr.querySelectorAll('button').forEach((b) => (b.disabled = true));
  msg.textContent = '';
  try {
    await api(`/api/admin/approvals/${id}/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    msg.textContent = what === 'approve' ? 'Approved.' : 'Rejected.';
    msg.className = 'msg ok';
    await load();
    updateNavBadge();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg err';
    tr.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

function updateNavBadge() {
  api('/api/admin/approvals').then(({ count }) => {
    const link = [...document.querySelectorAll('.topbar nav a')].find((a) => a.textContent.startsWith('Approvals'));
    if (!link) return;
    const existing = link.querySelector('.badge');
    if (count > 0) {
      if (existing) existing.textContent = count;
      else link.insertAdjacentHTML('beforeend', ` <span class="badge">${count}</span>`);
    } else if (existing) existing.remove();
  }).catch(() => {});
}

load().catch((e) => { msg.textContent = e.message; msg.className = 'msg err'; });
