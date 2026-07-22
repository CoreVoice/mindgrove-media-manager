'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}

const msg = document.getElementById('importMsg');
const summaryEl = document.getElementById('importSummary');

document.getElementById('importBtn').addEventListener('click', async () => {
  const file = document.getElementById('importFile').files[0];
  if (!file) { msg.textContent = 'Choose an export file first.'; msg.className = 'msg err'; return; }
  const fd = new FormData();
  fd.append('file', file);
  msg.textContent = 'Importing…'; msg.className = 'msg';
  summaryEl.classList.add('hidden');
  try {
    const r = await api('/api/admin/import', { method: 'POST', body: fd });
    msg.textContent = 'Import complete.'; msg.className = 'msg ok';
    const s = r.summary;
    summaryEl.innerHTML = `
      <table class="grid">
        <thead><tr><th>Type</th><th>Matched / kept</th><th>Inserted</th><th>Skipped</th></tr></thead>
        <tbody>
          <tr><td>Pages</td><td>${s.pages.matched}</td><td>${s.pages.inserted}</td><td>—</td></tr>
          <tr><td>Sections</td><td>${s.sections.matched}</td><td>${s.sections.inserted}</td><td>—</td></tr>
          <tr><td>Variants</td><td>${s.variants.matched}</td><td>${s.variants.inserted}</td><td>—</td></tr>
          <tr><td>Links</td><td>—</td><td>${s.links.inserted}</td><td>${s.links.skipped} (slug already existed)</td></tr>
          <tr><td>Redirects</td><td>—</td><td>${s.redirects.inserted}</td><td>${s.redirects.skipped}</td></tr>
        </tbody>
      </table>`;
    summaryEl.classList.remove('hidden');
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
});
