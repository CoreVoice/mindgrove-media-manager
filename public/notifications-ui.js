'use strict';

(function () {
  const bellBtn = document.getElementById('bellBtn');
  if (!bellBtn) return;
  const badge = document.getElementById('notifBadge');
  const menu = document.getElementById('notifMenu');
  const list = document.getElementById('notifList');
  const empty = document.getElementById('notifEmpty');

  function esc(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtIST(sqliteUtc) {
    if (!sqliteUtc) return '';
    const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
  }

  async function refreshCount() {
    try {
      const r = await fetch('/api/notifications/unread-count', { headers: { 'X-Requested-With': 'fetch' } });
      const d = await r.json();
      if (d.unread > 0) { badge.textContent = d.unread; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    } catch (_) { /* ignore */ }
  }

  async function openMenu() {
    const wasHidden = menu.classList.contains('hidden');
    if (!wasHidden) { menu.classList.add('hidden'); return; }
    menu.classList.remove('hidden');

    const r = await fetch('/api/notifications', { headers: { 'X-Requested-With': 'fetch' } });
    const d = await r.json();
    list.innerHTML = '';
    empty.classList.toggle('hidden', d.items.length > 0);
    d.items.forEach((n) => {
      const a = document.createElement('a');
      a.className = 'notifitem' + (n.read ? '' : ' unread');
      const params = new URLSearchParams();
      if (n.page_id) params.set('nPage', n.page_id);
      if (n.section_id) params.set('nSection', n.section_id);
      if (n.variant_id) params.set('nVariant', n.variant_id);
      if (n.link_id) params.set('nLink', n.link_id);
      a.href = '/?' + params.toString();
      a.innerHTML = `<div class="notifmsg">${esc(n.message)}</div><div class="muted small">${fmtIST(n.created_at)}</div>`;
      list.appendChild(a);
    });
    if (d.unread > 0) {
      fetch('/api/notifications/read-all', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } }).then(refreshCount);
    }
  }

  bellBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== bellBtn) menu.classList.add('hidden');
  });

  refreshCount();
  setInterval(refreshCount, 20000);
})();
