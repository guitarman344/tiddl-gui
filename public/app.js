// ── WebSocket ──────────────────────────────────────────────
let ws;
let reconnectTimer;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setStatus('connected', 'Connesso');
    clearTimeout(reconnectTimer);
    // dopo una riconnessione riallinea lo stato col server
    syncActiveDownloads();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus('error', 'Disconnesso');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    setStatus('error', 'Errore connessione');
  };
}

function handleMessage(msg) {
  switch (msg.event) {
    case 'download_started':
      addActiveDownload(msg.data);
      showToast(`Download avviato: ${msg.data.type}`, 'info');
      break;
    case 'download_log':
      updateDownloadLog(msg.id, msg.text, msg.isErr, msg.progress);
      break;
    case 'download_done':
      finalizeDownload(msg.id, msg.status, msg.error, msg.errorCount);
      break;
    case 'auth_log':
      appendAuthLog(msg.text);
      break;
    case 'auth_url':
      showAuthUrl(msg.url);
      break;
    case 'auth_done':
      onAuthDone(msg.success);
      break;
  }
}

// ── Status ─────────────────────────────────────────────────
function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'status-dot ' + state;
  label.textContent = text;
}

// ── Tabs ───────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tabDownload').classList.toggle('active', tab === 'download');
  document.getElementById('tabSearch').classList.toggle('active', tab === 'search');
  document.getElementById('panelDownload').style.display = tab === 'download' ? 'block' : 'none';
  document.getElementById('panelSearch').style.display = tab === 'search' ? 'block' : 'none';
  if (tab === 'search') document.getElementById('searchInput').focus();
}

// ── URL detection ──────────────────────────────────────────
const urlInput = document.getElementById('tidalUrl');

urlInput.addEventListener('input', detectUrlType);

const URL_TYPES = [
  ['/album/',    '💿', 'Album',    'Album'],
  ['/track/',    '🎵', 'Traccia',  'Traccia'],
  ['/playlist/', '📋', 'Playlist', 'Playlist'],
  ['/video/',    '🎬', 'Video',    'Video'],
  ['/artist/',   '🎤', 'Artista',  'Artista'],
  ['/mix/',      '🎛️', 'Mix',      'Mix'],
];

function isTidalUrl(str) {
  try {
    const u = new URL(str);
    return /^https?:$/.test(u.protocol) && (u.hostname === 'tidal.com' || u.hostname.endsWith('.tidal.com'));
  } catch {
    return false;
  }
}

function detectUrlType() {
  const url = urlInput.value.trim();
  const wrap = document.getElementById('typeBadgeWrap');
  const badge = document.getElementById('typeBadge');

  if (!url || !isTidalUrl(url)) { wrap.style.display = 'none'; return; }

  const match = URL_TYPES.find(([seg]) => url.includes(seg));
  const [, icon, label, type] = match || [null, '🎧', 'Link TIDAL', ''];

  badge.textContent = `${icon} ${label}`;
  badge.className = `type-badge ${type}`;
  wrap.style.display = 'block';
}

// ── Paste from clipboard ───────────────────────────────────
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    detectUrlType();
    urlInput.focus();
  } catch {
    showToast('Incolla manualmente con Cmd+V', 'info');
  }
}

// ── Browse Folder (Mac) ────────────────────────────────────
async function browseFolder() {
  try {
    const res = await fetch('/api/browse');
    const data = await res.json();
    if (data.unsupported) {
      showToast('Selezione cartella disponibile solo su macOS: scrivi il percorso a mano', 'info');
      document.getElementById('downloadPath').focus();
    } else if (data.path) {
      document.getElementById('downloadPath').value = data.path;
      saveSettings();
    }
  } catch (err) {
    showToast('Errore durante la selezione della cartella', 'error');
  }
}

// ── Settings persistence (localStorage) ────────────────────
const SETTINGS_KEY = 'tiddl-gui-settings';
const SETTINGS_FIELDS = ['quality', 'downloadPath', 'template'];

function saveSettings() {
  try {
    const s = {};
    SETTINGS_FIELDS.forEach(f => s[f] = document.getElementById(f).value);
    s.saveCovers = document.getElementById('saveCovers').checked;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return;
    SETTINGS_FIELDS.forEach(f => { if (typeof s[f] === 'string') document.getElementById(f).value = s[f]; });
    if (typeof s.saveCovers === 'boolean') document.getElementById('saveCovers').checked = s.saveCovers;
  } catch {}
}

SETTINGS_FIELDS.forEach(f => document.getElementById(f).addEventListener('change', saveSettings));
document.getElementById('saveCovers').addEventListener('change', saveSettings);

// ── Start Download ─────────────────────────────────────────
async function startDownload(overrideUrl) {
  const url          = (overrideUrl || urlInput.value).trim();
  const quality      = document.getElementById('quality').value;
  const downloadPath = document.getElementById('downloadPath').value.trim();
  const template     = document.getElementById('template').value.trim();
  const saveCovers   = document.getElementById('saveCovers').checked;

  if (!url) { showToast('Inserisci un URL TIDAL', 'error'); urlInput.focus(); return; }
  if (!isTidalUrl(url)) { showToast('URL non valido: deve essere un link tidal.com', 'error'); return; }

  const btn = document.getElementById('btnDownload');
  const btnText = document.getElementById('btnDownloadText');
  if (!overrideUrl) {
    if (btn.disabled) return; // evita doppio avvio (Invio + click)
    btn.disabled = true;
    btnText.textContent = 'Avvio in corso…';
  }

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality, downloadPath, template, saveCovers })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Errore server (${res.status})`);

    if (!overrideUrl) {
      urlInput.value = '';
      document.getElementById('typeBadgeWrap').style.display = 'none';
    }
    return true;
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
    return false;
  } finally {
    if (!overrideUrl) {
      btn.disabled = false;
      btnText.textContent = 'Avvia Download';
    }
  }
}

// ── Download from search result ────────────────────────────
async function downloadFromSearch(url, name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Avvio…'; }
  const ok = await startDownload(url);
  if (btn) {
    btn.textContent = ok ? '✓ In coda' : btn.dataset.label;
    if (!ok) btn.disabled = false;
  }
  if (ok) showToast(`⬇ Download: ${name}`, 'info');
}

// ── Search ─────────────────────────────────────────────────
let searchFilter = 'all';
let searchDebounce;
let searchSeq = 0;

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doSearch, 400);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchDebounce); doSearch(); }
});

function setSearchFilter(filter, el) {
  searchFilter = filter;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  doSearch();
}

async function doSearch() {
  const q = searchInput.value.trim();
  const results = document.getElementById('searchResults');
  const loading = document.getElementById('searchLoading');
  const seq = ++searchSeq;

  if (!q) {
    loading.style.display = 'none';
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>Cerca un artista o album per iniziare</p></div>`;
    return;
  }

  results.innerHTML = '';
  loading.style.display = 'flex';

  try {
    const typeParam = searchFilter === 'all' ? '' : `&type=${searchFilter}`;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${typeParam}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== searchSeq) return; // è arrivata una ricerca più recente

    if (!res.ok) throw new Error(data.error || 'Errore ricerca');

    loading.style.display = 'none';
    renderSearchResults(data);
  } catch (err) {
    if (seq !== searchSeq) return;
    loading.style.display = 'none';
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><p>${escHtml(err.message)}</p></div>`;
  }
}

function coverHtml(src, alt, icon) {
  return src
    ? `<img class="result-cover" src="${escHtml(src)}" alt="${escHtml(alt)}" loading="lazy" data-icon="${icon}" />`
    : `<div class="result-cover-placeholder">${icon}</div>`;
}

function resultCard({ url, name, cover, icon, extraCls = '', subtitle = '', meta = [], btnLabel }) {
  return `
    <div class="result-card ${extraCls}" data-url="${escHtml(url)}" data-name="${escHtml(name)}">
      ${coverHtml(cover, name, icon)}
      <div class="result-body">
        <div class="result-title">${escHtml(name)}</div>
        ${subtitle ? `<div class="result-artist">${escHtml(subtitle)}</div>` : ''}
        ${meta.length ? `<div class="result-meta">${meta.map(m => `<span>${escHtml(m)}</span>`).join('')}</div>` : ''}
        <button class="result-dl-btn" data-label="${escHtml(btnLabel)}">${escHtml(btnLabel)}</button>
      </div>
    </div>`;
}

function renderSection(title, count, cardsHtml) {
  const section = document.createElement('div');
  section.className = 'result-section';
  section.innerHTML = `
    <div class="result-section-title">${title} <span class="result-section-count">${count}</span></div>
    <div class="result-grid">${cardsHtml}</div>`;
  return section;
}

function renderSearchResults(data) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  const show = f => searchFilter === 'all' || searchFilter === f;
  const artists = show('artists') ? (data.artists || []) : [];
  const albums  = show('albums')  ? (data.albums  || []) : [];
  const tracks  = show('tracks')  ? (data.tracks  || []) : [];

  if (!artists.length && !albums.length && !tracks.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p>Nessun risultato trovato</p></div>`;
    return;
  }

  if (artists.length) {
    container.appendChild(renderSection('🎤 Artisti', artists.length, artists.map(a => resultCard({
      url: a.url, name: a.name, cover: a.picture, icon: '🎤', extraCls: 'artist',
      btnLabel: '⬇ Scarica discografia'
    })).join('')));
  }

  if (albums.length) {
    container.appendChild(renderSection('💿 Album', albums.length, albums.map(a => resultCard({
      url: a.url, name: a.title, cover: a.cover, icon: '💿', subtitle: a.artist,
      meta: [a.year, a.tracks ? `${a.tracks} tracce` : ''].filter(Boolean),
      btnLabel: '⬇ Scarica album'
    })).join('')));
  }

  if (tracks.length) {
    container.appendChild(renderSection('🎵 Tracce', tracks.length, tracks.map(t => resultCard({
      url: t.url, name: t.title, cover: t.cover, icon: '🎵', subtitle: t.artist,
      meta: [t.album, t.duration ? formatDuration(t.duration) : ''].filter(Boolean),
      btnLabel: '⬇ Scarica traccia'
    })).join('')));
  }
}

// Click sui risultati (delegato: niente onclick inline con stringhe da escapare)
document.getElementById('searchResults').addEventListener('click', (e) => {
  const card = e.target.closest('.result-card');
  if (!card) return;
  const btn = card.querySelector('.result-dl-btn');
  if (btn.disabled) return;
  downloadFromSearch(card.dataset.url, card.dataset.name, btn);
});

// Copertine che non si caricano → placeholder
document.getElementById('searchResults').addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  const ph = document.createElement('div');
  ph.className = 'result-cover-placeholder';
  ph.textContent = img.dataset.icon || '🎵';
  img.replaceWith(ph);
}, true);

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Active downloads ───────────────────────────────────────
const activeMap = {};

function addActiveDownload(data) {
  if (activeMap[data.id]) return;
  activeMap[data.id] = { entry: data, logs: [] };
  renderActiveSection();
  loadHistory();
}

// Al caricamento / riconnessione recupera i download già in corso
async function syncActiveDownloads() {
  try {
    const res = await fetch('/api/active');
    const list = await res.json();
    for (const entry of list) {
      if (activeMap[entry.id]) continue;
      activeMap[entry.id] = { entry, logs: [] };
      fetch(`/api/download/${entry.id}`).then(r => r.json()).then(full => {
        if (activeMap[entry.id] && full.logs) {
          activeMap[entry.id].logs = full.logs.map(l => ({ text: l.text, isErr: l.isErr }));
        }
      }).catch(() => {});
    }
    // download terminati mentre eravamo disconnessi
    const ids = new Set(list.map(e => e.id));
    Object.keys(activeMap).forEach(id => {
      if (!ids.has(id) && activeMap[id].entry.status === 'running') delete activeMap[id];
    });
    renderActiveSection();
    loadHistory();
  } catch {}
}

function updateDownloadLog(id, text, isErr, progress) {
  if (!activeMap[id]) return;
  activeMap[id].logs.push({ text, isErr });
  if (progress !== undefined) activeMap[id].entry.progress = progress;

  const el = document.getElementById(`dl-${id}`);
  if (el) {
    const bar = el.querySelector('.progress-fill');
    if (bar) bar.style.width = (progress || 0) + '%';
    const lastLog = el.querySelector('.dl-last-log');
    if (lastLog) {
      lastLog.textContent = text.length > 80 ? text.slice(0, 77) + '…' : text;
      lastLog.style.color = isErr ? 'var(--warning)' : 'var(--text-muted)';
    }
  }

  if (currentLogId === id) appendLogLine(text, isErr);
}

function finalizeDownload(id, status, error, errorCount) {
  if (activeMap[id]) {
    activeMap[id].entry.status = status;
    activeMap[id].entry.error = error;
  }

  const el = document.getElementById(`dl-${id}`);
  if (el) {
    const statusEl = el.querySelector('.dl-status');
    if (statusEl) {
      if (status === 'done') {
        statusEl.className = 'dl-status done';
        statusEl.textContent = errorCount ? '⚠️ Completato con errori' : '✅ Completato';
        const bar = el.querySelector('.progress-fill');
        if (bar) bar.style.width = '100%';
      } else {
        statusEl.className = 'dl-status error';
        statusEl.textContent = '❌ Errore';
      }
    }
    setTimeout(() => {
      const pw = el.querySelector('.progress-wrap');
      if (pw) pw.style.opacity = '0.4';
    }, 2000);
  }

  if (status === 'done' && !errorCount) showToast('✅ Download completato!', 'success');
  else if (status === 'done') showToast(`⚠️ Download completato con ${errorCount} errori (vedi log)`, 'info');
  else showToast('❌ Download fallito: ' + (error || 'errore sconosciuto'), 'error');

  setTimeout(() => {
    delete activeMap[id];
    renderActiveSection();
    loadHistory();
  }, 4000);
}

function renderActiveSection() {
  const section = document.getElementById('activeSection');
  const container = document.getElementById('activeDownloads');
  const ids = Object.keys(activeMap);

  if (ids.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '';
  ids.forEach(id => {
    const { entry, logs } = activeMap[id];
    const item = buildDownloadItem(entry, true);
    const last = logs[logs.length - 1];
    const lastLog = item.querySelector('.dl-last-log');
    if (last && lastLog) lastLog.textContent = last.text.length > 80 ? last.text.slice(0, 77) + '…' : last.text;
    container.appendChild(item);
  });
}

// ── History ────────────────────────────────────────────────
async function loadHistory() {
  const list = document.getElementById('historyList');
  let history;
  try {
    const res = await fetch('/api/history');
    history = await res.json();
  } catch {
    return;
  }

  const histItems = history.filter(h => !activeMap[h.id] && h.status !== 'running');

  if (histItems.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>Nessun download ancora</p></div>`;
    return;
  }

  list.innerHTML = '';
  histItems.forEach(item => list.appendChild(buildDownloadItem(item, false)));
}

async function clearHistory() {
  try {
    await fetch('/api/history', { method: 'DELETE' });
    await loadHistory();
    showToast('Storico cancellato', 'info');
  } catch {
    showToast('Impossibile cancellare lo storico', 'error');
  }
}

// ── Build download item DOM ────────────────────────────────
function buildDownloadItem(entry, isActive) {
  const el = document.createElement('div');
  el.className = 'dl-item';
  el.id = `dl-${entry.id}`;

  const withErrors = entry.status === 'done' && entry.errorCount > 0;
  const statusCls = entry.status === 'done' ? 'done' : entry.status === 'error' ? 'error' : 'running';
  const statusText = withErrors ? '⚠️ Completato con errori'
    : entry.status === 'done' ? '✅ Completato'
    : entry.status === 'error' ? '❌ Errore'
    : 'In corso…';
  const spinnerHtml = entry.status === 'running' ? '<div class="status-spinner"></div>' : '';

  const progress = entry.progress || 0;
  const time = entry.startTime ? new Date(entry.startTime).toLocaleTimeString('it-IT') : '';
  const shortUrl = entry.url.length > 55 ? entry.url.slice(0, 52) + '…' : entry.url;
  const typeCls = (entry.type || '').replace(/[^\w-]/g, '');

  el.innerHTML = `
    <div class="dl-header">
      <div class="dl-info">
        <span class="dl-type ${typeCls}">${escHtml(entry.type || '?')}</span>
        <div class="dl-url" title="${escHtml(entry.url)}">${escHtml(shortUrl)}</div>
        ${isActive ? `<div class="dl-last-log" style="font-size:11px;color:var(--text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%"></div>` : ''}
        ${!isActive && entry.error ? `<div style="font-size:11px;color:var(--${withErrors ? 'warning' : 'error'});margin-top:4px">${escHtml(entry.error)}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="dl-status ${statusCls}">
          ${spinnerHtml}
          <span>${statusText}</span>
        </div>
        <div class="dl-actions">
          <button class="dl-btn" data-log-id="${escHtml(entry.id)}">Log</button>
        </div>
      </div>
    </div>
    ${isActive ? `
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>
    ` : ''}
    <div class="dl-time">${entry.quality && entry.quality !== 'auto' ? `Qualità: ${escHtml(entry.quality)} · ` : ''}${entry.path ? `${escHtml(entry.path)} · ` : ''}${time}</div>
  `;

  el.querySelector('[data-log-id]').addEventListener('click', () => openLogModal(entry.id));
  return el;
}

// ── Log Modal ──────────────────────────────────────────────
let currentLogId = null;

function renderLogs(entry, logs) {
  const content = document.getElementById('logContent');
  const title = document.getElementById('logModalTitle');
  title.textContent = entry
    ? `Log — ${entry.type} · ${entry.url.length > 40 ? entry.url.slice(0, 40) + '…' : entry.url}`
    : 'Log Download';

  content.innerHTML = logs.length === 0
    ? '<span style="color:var(--text-muted)">Nessun log disponibile</span>'
    : logs.map(l => `<div class="${l.isErr ? 'log-line-err' : ''}">${escHtml(l.text)}</div>`).join('');
  content.scrollTop = content.scrollHeight;
}

async function openLogModal(id) {
  currentLogId = id;
  document.getElementById('logModal').style.display = 'flex';

  const active = activeMap[id];
  if (active) {
    renderLogs(active.entry, active.logs);
    return;
  }

  // download concluso: i log li ha il server
  renderLogs(null, []);
  try {
    const res = await fetch(`/api/download/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error();
    const entry = await res.json();
    if (currentLogId === id) renderLogs(entry, entry.logs || []);
  } catch {
    if (currentLogId === id) {
      document.getElementById('logContent').innerHTML =
        '<span style="color:var(--text-muted)">Log non più disponibili (il server è stato riavviato?)</span>';
    }
  }
}

function appendLogLine(text, isErr) {
  const content = document.getElementById('logContent');
  if (content.querySelector('span')) content.innerHTML = '';
  const line = document.createElement('div');
  if (isErr) line.className = 'log-line-err';
  line.textContent = text;
  const atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 40;
  content.appendChild(line);
  if (atBottom) content.scrollTop = content.scrollHeight;
}

function closeLogModal(e) {
  if (!e || e.target === document.getElementById('logModal')) {
    document.getElementById('logModal').style.display = 'none';
    currentLogId = null;
  }
}

// ── Auth Modal ─────────────────────────────────────────────
let isAuthenticated = false;
let authRunning = false;
let authWindow = null;

const AUTH_BTN_DEFAULT = '<span class="btn-icon">🔐</span> Avvia Autenticazione<div class="btn-shimmer"></div>';

function openAuthModal() {
  if (!authRunning) {
    document.getElementById('authLog').textContent = '';
    document.getElementById('authUrlBox').style.display = 'none';
    const btn = document.getElementById('btnStartAuth');
    btn.disabled = false;
    btn.innerHTML = AUTH_BTN_DEFAULT;
  }
  document.getElementById('btnLogout').style.display = isAuthenticated && !authRunning ? 'block' : 'none';
  document.getElementById('btnStartAuth').style.display = isAuthenticated && !authRunning ? 'none' : '';
  document.getElementById('authDesc').textContent = isAuthenticated
    ? 'Il tuo account TIDAL è già collegato. Puoi disconnetterlo se vuoi accedere con un altro account.'
    : 'Avvia il processo di autenticazione. Si aprirà un link TIDAL nel browser per completare il login.';
  document.getElementById('authModal').style.display = 'flex';
}

function closeAuthModal(e) {
  if (!e || e.target === document.getElementById('authModal')) {
    document.getElementById('authModal').style.display = 'none';
  }
}

function appendAuthLog(text) {
  const log = document.getElementById('authLog');
  log.textContent += (log.textContent ? '\n' : '') + text;
  log.scrollTop = log.scrollHeight;
}

function showAuthUrl(url) {
  const box = document.getElementById('authUrlBox');
  const link = document.getElementById('authUrl');
  link.href = url;
  link.textContent = url;
  box.style.display = 'block';
  // La finestra è stata aperta al click (altrimenti il browser blocca il popup):
  // ora le diamo l'indirizzo giusto.
  if (authWindow && !authWindow.closed) {
    authWindow.location.href = url;
  }
}

async function startAuth() {
  const btn = document.getElementById('btnStartAuth');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> In attesa del login su TIDAL…<div class="btn-shimmer"></div>';
  document.getElementById('authLog').textContent = '';
  document.getElementById('authUrlBox').style.display = 'none';
  authRunning = true;

  try { authWindow = window.open('about:blank', '_blank'); } catch { authWindow = null; }

  try {
    const res = await fetch('/api/auth', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Errore server (${res.status})`);
  } catch (err) {
    authRunning = false;
    if (authWindow && !authWindow.closed) authWindow.close();
    appendAuthLog(err.message);
    showToast('Errore avvio auth: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = AUTH_BTN_DEFAULT;
  }
}

function onAuthDone(success) {
  authRunning = false;
  const btn = document.getElementById('btnStartAuth');
  btn.disabled = false;
  if (success) {
    showToast('✅ Autenticazione completata!', 'success');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">✅</span> Account collegato<div class="btn-shimmer"></div>';
    setTimeout(() => closeAuthModal(), 1500);
  } else {
    // chiude la finestra vuota aperta al click, se non è mai arrivato il link
    try {
      if (authWindow && !authWindow.closed && authWindow.location.href === 'about:blank') authWindow.close();
    } catch {}
    showToast('❌ Autenticazione fallita', 'error');
    btn.innerHTML = '<span class="btn-icon">🔁</span> Riprova<div class="btn-shimmer"></div>';
  }
  authWindow = null;
  checkAuthStatus();
}

async function logout() {
  const btn = document.getElementById('btnLogout');
  btn.disabled = true;
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Errore');
    showToast('Account TIDAL disconnesso', 'info');
    await checkAuthStatus();
    openAuthModal();
  } catch (err) {
    showToast('Errore logout: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Auth Status Check ──────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    isAuthenticated = !!data.authenticated;
    const btn = document.getElementById('btnAuth');
    if (data.tiddlFound === false) {
      showToast('⚠️ tiddl non trovato sul computer: installalo con "pipx install tiddl"', 'error');
    }
    if (data.authenticated) {
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Account TIDAL connesso
      `;
      btn.style.borderColor = 'rgba(0,229,160,0.3)';
      btn.style.color = 'var(--success)';
    } else {
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Accedi a TIDAL
      `;
      btn.style.borderColor = '';
      btn.style.color = '';
    }
  } catch {}
}

// ── Toast ──────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = 'toast', type === 'error' ? 6000 : 3500);
}

// ── Helpers ────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allow Enter key to trigger download
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});

// Esc chiude le finestre
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeLogModal(); closeAuthModal(); }
});

// ── Init ───────────────────────────────────────────────────
loadSettings();
fetch('/api/defaults').then(r => r.json()).then(d => {
  if (d.downloadPath) document.getElementById('downloadPath').placeholder = `${d.downloadPath} (default)`;
}).catch(() => {});
connectWS();
loadHistory();
checkAuthStatus();
