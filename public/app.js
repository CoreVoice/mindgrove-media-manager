'use strict';

const isAdmin = document.body.dataset.role === 'admin';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fillSelect(sel, items, placeholder) {
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// SQLite's datetime('now') is UTC with no timezone marker — convert explicitly to IST (+5:30).
function fmtIST(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(d) + ' IST'
  );
}

const pageSel = document.getElementById('pageSel');
const sectionSel = document.getElementById('sectionSel');
const variantSel = document.getElementById('variantSel');
const slot = document.getElementById('slot');
const cards = document.getElementById('cards');
const emptyCards = document.getElementById('emptyCards');
const taxoHint = document.getElementById('taxoHint');

async function init() {
  taxoHint.classList.remove('hidden');
  fillSelect(pageSel, await api('/api/pages'), 'Select page…');
}

pageSel.addEventListener('change', async () => {
  resetFrom('section');
  if (!pageSel.value) return;
  fillSelect(sectionSel, await api(`/api/pages/${pageSel.value}/sections`), 'Select section…');
  sectionSel.disabled = false;
});

sectionSel.addEventListener('change', async () => {
  resetFrom('variant');
  if (!sectionSel.value) return;
  fillSelect(variantSel, await api(`/api/sections/${sectionSel.value}/variants`), 'Select variant…');
  variantSel.disabled = false;
});

variantSel.addEventListener('change', async () => {
  if (!variantSel.value) { slot.classList.add('hidden'); return; }
  slot.classList.remove('hidden');
  await loadFiles();
});

function resetFrom(level) {
  if (level === 'section') {
    fillSelect(sectionSel, [], 'Select section…'); sectionSel.disabled = true;
  }
  fillSelect(variantSel, [], 'Select variant…'); variantSel.disabled = true;
  slot.classList.add('hidden');
}

async function loadFiles() {
  const files = await api(`/api/variants/${variantSel.value}/files`);
  cards.innerHTML = '';
  emptyCards.classList.toggle('hidden', files.length > 0);
  for (const f of files) cards.appendChild(renderCard(f));
}

function renderCard(f) {
  const el = document.createElement('div');
  el.className = 'filecard';
  const driverLabel = f.driver === 'bunny' ? 'Bunny CDN' : f.driver === 's3' ? 'S3' : 'Local';
  el.innerHTML = `
    <div class="name">${escapeHtml(f.label)}</div>
    <div class="meta">
      <span class="tag ${f.driver}">${driverLabel}</span>
      <span>${escapeHtml(f.mime || 'file')}</span><span>·</span><span>${fmtSize(f.size)}</span>
    </div>
    <div class="meta updated">Updated ${fmtIST(f.updatedAt)}</div>
    <div class="linkline" data-role="display">
      <input type="text" readonly value="${escapeHtml(f.shortUrl)}" />
      <button class="btn small" data-act="copy">Copy</button>
    </div>
    <div class="linkline hidden" data-role="editor">
      <input type="text" class="slugEdit" value="${escapeHtml(f.slug)}" />
      <button class="btn small primary" data-act="saveslug">Save</button>
      <button class="btn small" data-act="cancelslug">Cancel</button>
    </div>
    <div class="actions">
      <button class="btn small" data-act="replace">Replace file</button>
      <button class="btn small" data-act="slug">Edit link</button>
      <button class="btn small danger" data-act="remove">Remove</button>
    </div>
    <div class="msg"></div>`;

  const msg = el.querySelector('.msg');
  const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); };
  const display = el.querySelector('[data-role="display"]');
  const editor = el.querySelector('[data-role="editor"]');
  const slugEdit = el.querySelector('.slugEdit');

  el.querySelector('[data-act="copy"]').onclick = () => {
    navigator.clipboard.writeText(f.shortUrl).then(() => say('Copied!'));
  };

  el.querySelector('[data-act="replace"]').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const fd = new FormData();
      fd.append('file', inp.files[0]);
      try {
        say('Uploading…');
        await api(`/api/links/${f.id}/replace`, { method: 'POST', body: fd });
        await loadFiles();
      } catch (e) { say(e.message, false); }
    };
    inp.click();
  };

  // inline slug editor (no window.prompt — blocked/no-op in some browsers)
  el.querySelector('[data-act="slug"]').onclick = () => {
    display.classList.add('hidden'); editor.classList.remove('hidden');
    slugEdit.value = f.slug; slugEdit.focus(); slugEdit.select();
  };
  el.querySelector('[data-act="cancelslug"]').onclick = () => {
    editor.classList.add('hidden'); display.classList.remove('hidden');
  };
  el.querySelector('[data-act="saveslug"]').onclick = async () => {
    const next = slugEdit.value.trim();
    if (!next || next === f.slug) { editor.classList.add('hidden'); display.classList.remove('hidden'); return; }
    try {
      const r = await api(`/api/links/${f.id}/slug`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: next }),
      });
      f.slug = r.slug; f.shortUrl = r.shortUrl;
      el.querySelector('[data-role="display"] input').value = r.shortUrl;
      editor.classList.add('hidden'); display.classList.remove('hidden');
      say('Short link updated. The old link still works — it forwards here.');
    } catch (e) { say(e.message, false); }
  };
  slugEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.querySelector('[data-act="saveslug"]').click();
    if (e.key === 'Escape') el.querySelector('[data-act="cancelslug"]').click();
  });

  // two-step remove (no window.confirm — blocked/no-op in some browsers)
  const removeBtn = el.querySelector('[data-act="remove"]');
  let armed = false, armTimer = null;
  removeBtn.onclick = async () => {
    if (!armed) {
      armed = true;
      removeBtn.textContent = 'Click again to confirm';
      armTimer = setTimeout(() => { armed = false; removeBtn.textContent = 'Remove'; }, 4000);
      return;
    }
    clearTimeout(armTimer);
    removeBtn.disabled = true;
    try {
      await api(`/api/links/${f.id}`, { method: 'DELETE' });
      await loadFiles();
    } catch (e) { say(e.message, false); removeBtn.disabled = false; armed = false; removeBtn.textContent = 'Remove'; }
  };

  return el;
}

// upload
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const slugInput = document.getElementById('slugInput');
const uploadMsg = document.getElementById('uploadMsg');

uploadBtn.addEventListener('click', async () => {
  if (!fileInput.files[0]) { uploadMsg.textContent = 'Choose a file first.'; uploadMsg.className = 'msg err'; return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('variant_id', variantSel.value);
  if (slugInput.value.trim()) fd.append('slug', slugInput.value.trim());
  uploadBtn.disabled = true;
  uploadMsg.textContent = 'Uploading…'; uploadMsg.className = 'msg';
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    uploadMsg.textContent = `Uploaded. Short link: ${r.shortUrl}`; uploadMsg.className = 'msg ok';
    fileInput.value = ''; slugInput.value = '';
    await loadFiles();
  } catch (e) {
    uploadMsg.textContent = e.message; uploadMsg.className = 'msg err';
  } finally {
    uploadBtn.disabled = false;
  }
});

// drag & drop onto the upload zone
const zone = document.getElementById('uploadZone');
if (zone) {
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); })
  );
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; }
  });
}

init().catch((e) => { uploadMsg && (uploadMsg.textContent = e.message); });
