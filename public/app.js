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
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtIST(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d) + ' IST';
}
function fillSelect(sel, items, placeholder) {
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
}

// ---- view + checksum prefs ----
let viewMode = localStorage.getItem('mg-view') === 'list' ? 'list' : 'cards';
let showChecksum = localStorage.getItem('mg-checksum') === '1';

const pageSel = document.getElementById('pageSel');
const sectionSel = document.getElementById('sectionSel');
const variantSel = document.getElementById('variantSel');
const slot = document.getElementById('slot');
const cards = document.getElementById('cards');
const emptyCards = document.getElementById('emptyCards');
const taxoHint = document.getElementById('taxoHint');
const tagOptions = document.getElementById('tagOptions');

let allTags = [];

async function init() {
  taxoHint.classList.remove('hidden');
  applyViewMode();
  document.getElementById('showChecksum').checked = showChecksum;
  fillSelect(pageSel, await api('/api/pages'), 'Select page…');
  await refreshTags();
}

async function refreshTags() {
  allTags = await api('/api/tags');
  tagOptions.innerHTML = allTags.map((t) => `<option value="${escapeHtml(t.name)}"></option>`).join('');
}

// ---- cascade ----
// Named (not just inline listeners) so restoreFromNotification() can await
// each step in sequence when landing here from a notification click.
async function onPageChange() {
  resetFrom('section');
  if (!pageSel.value) return;
  fillSelect(sectionSel, await api(`/api/pages/${pageSel.value}/sections`), 'Select section…');
  sectionSel.disabled = false;
}
async function onSectionChange() {
  resetFrom('variant');
  if (!sectionSel.value) return;
  fillSelect(variantSel, await api(`/api/sections/${sectionSel.value}/variants`), 'Select variant…');
  variantSel.disabled = false;
}
async function onVariantChange() {
  if (!variantSel.value) { slot.classList.add('hidden'); return; }
  slot.classList.remove('hidden');
  await loadFiles();
}
pageSel.addEventListener('change', onPageChange);
sectionSel.addEventListener('change', onSectionChange);
variantSel.addEventListener('change', onVariantChange);
function resetFrom(level) {
  if (level === 'section') { fillSelect(sectionSel, [], 'Select section…'); sectionSel.disabled = true; }
  fillSelect(variantSel, [], 'Select variant…'); variantSel.disabled = true;
  slot.classList.add('hidden');
}

/** Arrived via a notification click — restore that page/section/variant and highlight the file. */
async function restoreFromNotification() {
  const q = new URLSearchParams(location.search);
  const nPage = q.get('nPage');
  if (!nPage) return;
  const hasOption = (sel, val) => [...sel.options].some((o) => o.value === val);

  if (!hasOption(pageSel, nPage)) return;
  pageSel.value = nPage;
  await onPageChange();

  const nSection = q.get('nSection');
  if (nSection && hasOption(sectionSel, nSection)) {
    sectionSel.value = nSection;
    await onSectionChange();

    const nVariant = q.get('nVariant');
    if (nVariant && hasOption(variantSel, nVariant)) {
      variantSel.value = nVariant;
      await onVariantChange();

      const nLink = q.get('nLink');
      if (nLink) {
        const card = cards.querySelector(`[data-link-id="${nLink}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('highlight');
          setTimeout(() => card.classList.remove('highlight'), 3000);
        }
      }
    }
  }
  history.replaceState(null, '', location.pathname);
}

// ---- view toggle + checksum toggle ----
function applyViewMode() {
  cards.classList.toggle('list', viewMode === 'list');
  document.querySelectorAll('#viewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === viewMode));
}
document.getElementById('viewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  viewMode = btn.dataset.view; localStorage.setItem('mg-view', viewMode); applyViewMode();
});
document.getElementById('showChecksum').addEventListener('change', (e) => {
  showChecksum = e.target.checked; localStorage.setItem('mg-checksum', showChecksum ? '1' : '0');
  cards.classList.toggle('show-sum', showChecksum);
});

async function loadFiles() {
  const { files, pendingCreates } = await api(`/api/variants/${variantSel.value}/files`);
  cards.innerHTML = '';
  cards.classList.toggle('show-sum', showChecksum);
  const total = files.length + pendingCreates.length;
  emptyCards.classList.toggle('hidden', total > 0);
  for (const pc of pendingCreates) cards.appendChild(renderPendingCreate(pc));
  for (const f of files) cards.appendChild(renderCard(f));
}

// ---- tag chip picker (names only; backend resolves/creates) ----
function chipPicker(container, initial = []) {
  const chips = container.querySelector('.chips');
  const input = container.querySelector('.tagInput');
  const names = new Set(initial.map((t) => (typeof t === 'string' ? t : t.name)));
  function render() {
    chips.innerHTML = [...names].map((n) => `<span class="chip">${escapeHtml(n)}<button type="button" data-x="${escapeHtml(n)}">×</button></span>`).join('');
    chips.querySelectorAll('button[data-x]').forEach((b) => (b.onclick = () => { names.delete(b.dataset.x); render(); }));
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = input.value.trim().replace(/,+$/, '');
      if (v) { names.add(v); input.value = ''; render(); }
    }
  });
  render();
  return { names: () => [...names] };
}

const uploadTags = chipPicker(document.querySelector('[data-role="upload-tags"]'));

function pendingNote(res) {
  return res && res.pending ? 'Submitted for admin approval.' : null;
}

function renderPendingCreate(pc) {
  const el = document.createElement('div');
  el.className = 'filecard pending';
  el.innerHTML = `
    <div class="name">${escapeHtml(pc.label)} <span class="badge warn">Pending review</span></div>
    <div class="meta"><span>${escapeHtml(pc.mime || 'file')}</span><span>·</span><span>${fmtSize(pc.size)}</span></div>
    <div class="meta updated">Requested by ${escapeHtml(pc.requestedBy)} · ${fmtIST(pc.requestedAt)}</div>
    <div class="muted small">Not live yet — an admin must approve this upload.</div>`;
  return el;
}

function renderCard(f) {
  const el = document.createElement('div');
  el.className = 'filecard';
  el.dataset.linkId = f.id;
  const driverLabel = f.driver === 'bunny' ? 'Bunny CDN' : f.driver === 's3' ? 'S3' : 'Local';
  const tagsHtml = f.tags.map((t) => `<span class="chip readonly">${escapeHtml(t.name)}</span>`).join('');
  const pendingBadge = f.pending
    ? `<span class="badge warn" title="A ${escapeHtml(f.pending.kind)} change is awaiting review">Change pending</span>` : '';
  el.innerHTML = `
    <div class="name">${escapeHtml(f.label)} ${pendingBadge}</div>
    <div class="meta">
      <span class="tag ${f.driver}">${driverLabel}</span>
      <span>${escapeHtml(f.mime || 'file')}</span><span>·</span><span>${fmtSize(f.size)}</span>
    </div>
    <div class="meta updated">Updated ${fmtIST(f.updatedAt)}</div>
    <div class="cardtags">${tagsHtml || '<span class="muted small">no tags</span>'}</div>
    <div class="checksum"><code title="SHA-256">${f.checksum ? escapeHtml(f.checksum) : '—'}</code>${f.checksum ? '<button class="btn small" data-act="copysum">Copy</button>' : ''}</div>
    <div class="linkline" data-role="display">
      <input type="text" readonly value="${escapeHtml(f.shortUrl)}" />
      <button class="btn small" data-act="copy">Copy</button>
    </div>
    <div class="linkline hidden" data-role="editor">
      <input type="text" class="slugEdit" value="${escapeHtml(f.slug)}" />
      <button class="btn small primary" data-act="saveslug">Save</button>
      <button class="btn small" data-act="cancelslug">Cancel</button>
    </div>
    <div class="tagpicker hidden" data-role="tag-editor">
      <span class="muted small">Tags:</span><span class="chips"></span>
      <input type="text" class="tagInput" list="tagOptions" placeholder="add tag + Enter" />
      <button class="btn small primary" data-act="savetags">Save</button>
      <button class="btn small" data-act="canceltags">Cancel</button>
    </div>
    <div class="actions">
      <a class="btn small" href="${escapeHtml(f.shortUrl)}" data-act="download">Download</a>
      <button class="btn small" data-act="replace">Replace file</button>
      <button class="btn small" data-act="slug">Edit link</button>
      <button class="btn small" data-act="tags">Tags</button>
      <button class="btn small danger" data-act="remove">Remove</button>
    </div>
    <div class="msg"></div>`;

  const msg = el.querySelector('.msg');
  const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); };
  const display = el.querySelector('[data-role="display"]');
  const editor = el.querySelector('[data-role="editor"]');
  const tagEditor = el.querySelector('[data-role="tag-editor"]');
  const slugEdit = el.querySelector('.slugEdit');

  const sumBtn = el.querySelector('[data-act="copysum"]');
  if (sumBtn) sumBtn.onclick = () => navigator.clipboard.writeText(f.checksum).then(() => say('Checksum copied.'));

  el.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(f.shortUrl).then(() => say('Link copied.'));

  el.querySelector('[data-act="replace"]').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const fd = new FormData(); fd.append('file', inp.files[0]);
      try { say('Uploading…'); const r = await api(`/api/links/${f.id}/replace`, { method: 'POST', body: fd });
        say(pendingNote(r) || 'File replaced.'); await loadFiles();
      } catch (e) { say(e.message, false); }
    };
    inp.click();
  };

  // slug editor
  el.querySelector('[data-act="slug"]').onclick = () => { display.classList.add('hidden'); editor.classList.remove('hidden'); slugEdit.value = f.slug; slugEdit.focus(); slugEdit.select(); };
  el.querySelector('[data-act="cancelslug"]').onclick = () => { editor.classList.add('hidden'); display.classList.remove('hidden'); };
  el.querySelector('[data-act="saveslug"]').onclick = async () => {
    const next = slugEdit.value.trim();
    if (!next || next === f.slug) { editor.classList.add('hidden'); display.classList.remove('hidden'); return; }
    try {
      const r = await api(`/api/links/${f.id}/slug`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: next }) });
      editor.classList.add('hidden'); display.classList.remove('hidden');
      say(pendingNote(r) || 'Short link updated. Old link still forwards here.');
      if (r.applied) await loadFiles();
    } catch (e) { say(e.message, false); }
  };
  slugEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.querySelector('[data-act="saveslug"]').click();
    if (e.key === 'Escape') el.querySelector('[data-act="cancelslug"]').click();
  });

  // tags editor
  let picker = null;
  el.querySelector('[data-act="tags"]').onclick = () => {
    tagEditor.classList.remove('hidden');
    picker = chipPicker(tagEditor, f.tags);
  };
  el.querySelector('[data-act="canceltags"]').onclick = () => { tagEditor.classList.add('hidden'); };
  el.querySelector('[data-act="savetags"]').onclick = async () => {
    try {
      const r = await api(`/api/links/${f.id}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagIds: [], newTags: picker.names() }) });
      tagEditor.classList.add('hidden');
      say(pendingNote(r) || 'Tags updated.');
      await refreshTags();
      if (r.applied) await loadFiles();
    } catch (e) { say(e.message, false); }
  };

  // remove (two-click confirm)
  const removeBtn = el.querySelector('[data-act="remove"]');
  let armed = false, armTimer = null;
  removeBtn.onclick = async () => {
    if (!armed) { armed = true; removeBtn.textContent = 'Click again to confirm'; armTimer = setTimeout(() => { armed = false; removeBtn.textContent = 'Remove'; }, 4000); return; }
    clearTimeout(armTimer); removeBtn.disabled = true;
    try { const r = await api(`/api/links/${f.id}`, { method: 'DELETE' });
      if (r.applied) { await loadFiles(); } else { say('Deletion submitted for approval.'); removeBtn.disabled = false; armed = false; removeBtn.textContent = 'Remove'; }
    } catch (e) { say(e.message, false); removeBtn.disabled = false; armed = false; removeBtn.textContent = 'Remove'; }
  };

  return el;
}

// ---- upload ----
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
  fd.append('newTags', JSON.stringify(uploadTags.names()));
  uploadBtn.disabled = true;
  uploadMsg.textContent = 'Uploading…'; uploadMsg.className = 'msg';
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    uploadMsg.textContent = r.pending ? 'Uploaded — submitted for admin approval.' : `Uploaded. Short link: ${location.origin}/f/${r.slug}`;
    uploadMsg.className = 'msg ok';
    fileInput.value = ''; slugInput.value = '';
    await refreshTags();
    await loadFiles();
  } catch (e) {
    uploadMsg.textContent = e.message; uploadMsg.className = 'msg err';
  } finally { uploadBtn.disabled = false; }
});

// drag & drop
const zone = document.getElementById('uploadZone');
if (zone) {
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) fileInput.files = e.dataTransfer.files; });
}

init()
  .then(restoreFromNotification)
  .catch((e) => { uploadMsg && (uploadMsg.textContent = e.message); });
