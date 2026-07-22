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
const nullSpan = '<span class="muted">NULL</span>';

const tableList = document.getElementById('tableList');
const tableTitle = document.getElementById('tableTitle');
const grid = document.getElementById('dataGrid');
const pageInfo = document.getElementById('pageInfo');
const browseMsg = document.getElementById('browseMsg');
const browsePane = document.getElementById('browsePane');
const sqlPane = document.getElementById('sqlPane');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');

const state = { table: null, columns: [], limit: 50, offset: 0, total: 0 };

async function loadTables() {
  const tables = await api('/api/admin/db/tables');
  tableList.innerHTML = '';
  tables.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tname">${esc(t.name)}</span><span class="muted small">${t.count}</span>`;
    li.dataset.name = t.name;
    li.onclick = () => selectTable(t.name);
    tableList.appendChild(li);
  });
  if (tables.length) selectTable(tables[0].name);
}

async function selectTable(name) {
  state.table = name;
  state.offset = 0;
  [...tableList.children].forEach((li) => li.classList.toggle('active', li.dataset.name === name));
  tableTitle.textContent = name;
  showBrowse();
  await loadRows();
}

async function loadRows() {
  browseMsg.textContent = ''; browseMsg.className = 'msg';
  const data = await api(`/api/admin/db/tables/${state.table}/rows?limit=${state.limit}&offset=${state.offset}`);
  state.columns = data.columns;
  state.total = data.total;
  renderGrid(data.rows);
  const end = Math.min(state.offset + state.limit, state.total);
  pageInfo.textContent = state.total ? `${state.offset + 1}-${end} of ${state.total}` : 'No rows';
  prevBtn.disabled = state.offset <= 0;
  nextBtn.disabled = end >= state.total;
}

function renderGrid(rows) {
  const cols = state.columns.map((c) => c.name);
  grid.querySelector('thead').innerHTML =
    '<tr><th>rowid</th>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '<th></th></tr>';
  const tbody = grid.querySelector('tbody');
  tbody.innerHTML = '';
  rows.forEach((row) => tbody.appendChild(renderRow(row, cols)));
}

function renderRow(row, cols) {
  const tr = document.createElement('tr');
  const rowid = row._rowid;
  let html = `<td class="muted small">${rowid}</td>`;
  cols.forEach((c) => {
    const v = row[c];
    html += `<td data-col="${esc(c)}" class="dbcell" title="Click to edit">${v === null ? nullSpan : esc(v)}</td>`;
  });
  html += `<td><button class="btn small danger" data-act="del">Delete</button></td>`;
  tr.innerHTML = html;

  tr.querySelectorAll('.dbcell').forEach((td) => td.addEventListener('click', () => editCell(td, row, rowid)));

  const delBtn = tr.querySelector('[data-act="del"]');
  let armed = false, timer = null;
  delBtn.onclick = async () => {
    if (!armed) {
      armed = true; delBtn.textContent = 'Confirm?';
      timer = setTimeout(() => { armed = false; delBtn.textContent = 'Delete'; }, 4000);
      return;
    }
    clearTimeout(timer);
    try {
      await api(`/api/admin/db/tables/${state.table}/rows/${rowid}`, { method: 'DELETE' });
      await loadRows();
    } catch (e) { browseMsg.textContent = e.message; browseMsg.className = 'msg err'; }
  };
  return tr;
}

function editCell(td, row, rowid) {
  if (td.querySelector('input')) return;
  const col = td.dataset.col;
  const current = row[col];
  const input = document.createElement('input');
  input.type = 'text'; input.value = current === null ? '' : current; input.className = 'cellinput';
  td.innerHTML = ''; td.appendChild(input); input.focus(); input.select();

  const restore = () => { td.innerHTML = current === null ? nullSpan : esc(current); };
  const save = async () => {
    const val = input.value;
    if (val === (current === null ? '' : String(current))) return restore();
    try {
      await api(`/api/admin/db/tables/${state.table}/rows/${rowid}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [col]: val }),
      });
      row[col] = val;
      td.innerHTML = val === '' ? nullSpan : esc(val);
    } catch (e) {
      browseMsg.textContent = e.message; browseMsg.className = 'msg err';
      restore();
    }
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') restore();
  });
}

prevBtn.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); };
nextBtn.onclick = () => { state.offset += state.limit; loadRows(); };

document.getElementById('addRowBtn').onclick = () => {
  if (!state.table) return;
  const tbody = grid.querySelector('tbody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td class="muted small">new</td>' +
    state.columns
      .map((c) =>
        c.pk && /INTEGER/i.test(c.type)
          ? '<td class="muted small">auto</td>'
          : `<td><input type="text" data-col="${esc(c.name)}" class="cellinput" placeholder="${esc(c.name)}" /></td>`
      )
      .join('') +
    '<td><button class="btn small primary" data-act="save">Save</button></td>';
  tbody.prepend(tr);
  tr.querySelector('input')?.focus();
  tr.querySelector('[data-act="save"]').onclick = async () => {
    const body = {};
    tr.querySelectorAll('input[data-col]').forEach((inp) => { if (inp.value !== '') body[inp.dataset.col] = inp.value; });
    try {
      await api(`/api/admin/db/tables/${state.table}/rows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await loadRows();
    } catch (e) { browseMsg.textContent = e.message; browseMsg.className = 'msg err'; }
  };
};

document.getElementById('tabBrowse').onclick = showBrowse;
document.getElementById('tabSql').onclick = showSql;
function showBrowse() { browsePane.classList.remove('hidden'); sqlPane.classList.add('hidden'); }
function showSql() { browsePane.classList.add('hidden'); sqlPane.classList.remove('hidden'); }

document.getElementById('runSqlBtn').onclick = async () => {
  const sql = document.getElementById('sqlInput').value.trim();
  const msg = document.getElementById('sqlMsg');
  const resultTable = document.getElementById('sqlResult');
  if (!sql) return;
  msg.textContent = ''; msg.className = 'msg';
  try {
    const r = await api('/api/admin/db/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
    });
    if (r.rows) {
      const cols = r.rows.length ? Object.keys(r.rows[0]) : [];
      resultTable.querySelector('thead').innerHTML = cols.length ? '<tr>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr>' : '';
      resultTable.querySelector('tbody').innerHTML = r.rows
        .map((row) => '<tr>' + cols.map((c) => `<td>${row[c] === null ? nullSpan : esc(row[c])}</td>`).join('') + '</tr>')
        .join('');
      msg.textContent = `${r.rowCount} row(s)`; msg.className = 'msg ok';
    } else {
      resultTable.querySelector('thead').innerHTML = '';
      resultTable.querySelector('tbody').innerHTML = '';
      msg.textContent = `OK — ${r.changes} row(s) changed`; msg.className = 'msg ok';
      if (state.table) loadRows();
    }
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
};

loadTables().catch((e) => { tableList.innerHTML = `<li class="muted small">${esc(e.message)}</li>`; });
