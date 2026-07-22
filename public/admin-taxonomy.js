'use strict';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'fetch' }, ...opts });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `Failed (${res.status})`);
  return data;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const msg = document.getElementById('taxoMsg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); };

const state = { page: null, section: null };
const forms = {
  page: document.querySelector('[data-add="page"]'),
  section: document.querySelector('[data-add="section"]'),
  variant: document.querySelector('[data-add="variant"]'),
};

function renderList(ul, items, kind, onSelect) {
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tname">${esc(it.name)}</span>
      <button class="mini" data-act="rename">✎</button>
      <button class="mini" data-act="del">🗑</button>`;
    if (onSelect) li.querySelector('.tname').onclick = () => onSelect(it, li);
    li.querySelector('[data-act="rename"]').onclick = async (e) => {
      e.stopPropagation();
      const name = prompt(`Rename ${kind}:`, it.name);
      if (!name) return;
      try { await api(`/api/${kind}s/${it.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); await reloadAll(); say('Renamed.'); }
      catch (err) { say(err.message, false); }
    };
    li.querySelector('[data-act="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${kind} "${it.name}"? This cascades to everything beneath it, including files.`)) return;
      try { await api(`/api/${kind}s/${it.id}`, { method: 'DELETE' }); await reloadAll(); say('Deleted.'); }
      catch (err) { say(err.message, false); }
    };
    ul.appendChild(li);
  }
}

async function loadPages() {
  renderList(document.getElementById('pageList'), await api('/api/pages'), 'page', async (it, li) => {
    state.page = it.id; state.section = null;
    markActive('pageList', li);
    document.getElementById('secCtx').textContent = `· ${it.name}`;
    forms.section.classList.remove('hidden');
    forms.variant.classList.add('hidden');
    document.getElementById('variantList').innerHTML = '';
    document.getElementById('varCtx').textContent = '';
    await loadSections();
  });
}
async function loadSections() {
  if (!state.page) return;
  renderList(document.getElementById('sectionList'), await api(`/api/pages/${state.page}/sections`), 'section', async (it, li) => {
    state.section = it.id;
    markActive('sectionList', li);
    document.getElementById('varCtx').textContent = `· ${it.name}`;
    forms.variant.classList.remove('hidden');
    await loadVariants();
  });
}
async function loadVariants() {
  if (!state.section) return;
  renderList(document.getElementById('variantList'), await api(`/api/sections/${state.section}/variants`), 'variant', null);
}
function markActive(listId, li) {
  document.querySelectorAll(`#${listId} li`).forEach((x) => x.classList.remove('active'));
  li.classList.add('active');
}

async function reloadAll() {
  await loadPages();
  if (state.page) await loadSections();
  if (state.section) await loadVariants();
}

forms.page.addEventListener('submit', addHandler('page', () => ({})));
forms.section.addEventListener('submit', addHandler('section', () => ({ page_id: state.page })));
forms.variant.addEventListener('submit', addHandler('variant', () => ({ section_id: state.section })));

function addHandler(kind, extra) {
  return async (ev) => {
    ev.preventDefault();
    const input = ev.target.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    try {
      await api(`/api/${kind}s`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...extra() }) });
      input.value = '';
      if (kind === 'page') await loadPages();
      else if (kind === 'section') await loadSections();
      else await loadVariants();
      say(`${kind} added.`);
    } catch (e) { say(e.message, false); }
  };
}

loadPages().catch((e) => say(e.message, false));
