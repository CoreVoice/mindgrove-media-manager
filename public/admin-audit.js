'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtIST(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

const state = { limit: 50, offset: 0, action: '' };
const tbody = document.querySelector('#auditTable tbody');
const pageInfo = document.getElementById('pageInfo');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const filter = document.getElementById('actionFilter');
const msg = document.getElementById('msg');

async function load() {
  const q = new URLSearchParams({ limit: state.limit, offset: state.offset });
  if (state.action) q.set('action', state.action);
  const { rows, total, actions } = await api(`/api/admin/audit?${q}`);

  if (!filter.dataset.filled) {
    filter.innerHTML = '<option value="">All actions</option>' + actions.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    filter.dataset.filled = '1';
  }

  tbody.innerHTML = rows
    .map((r) => `<tr><td class="muted small">${fmtIST(r.created_at)}</td><td>${esc(r.actor_username || '—')}</td><td><span class="tag">${esc(r.action)}</span></td><td>${esc(r.summary)}</td></tr>`)
    .join('');

  const end = Math.min(state.offset + state.limit, total);
  pageInfo.textContent = total ? `${state.offset + 1}-${end} of ${total}` : 'No entries';
  prevBtn.disabled = state.offset <= 0;
  nextBtn.disabled = end >= total;
}

filter.addEventListener('change', () => { state.action = filter.value; state.offset = 0; load(); });
prevBtn.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
nextBtn.addEventListener('click', () => { state.offset += state.limit; load(); });

load().catch((e) => { msg.textContent = e.message; msg.className = 'msg err'; });
