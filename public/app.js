// ── WebSocket ──────────────────────────────────────────────
let ws;
let reconnectTimer;

function connectWS() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    setStatus('connected', 'Connesso');
    clearTimeout(reconnectTimer);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus('error', 'Disconnesso');
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
      finalizeDownload(msg.id, msg.status, msg.error);
      break;
    case 'auth_log':
      appendAuthLog(msg.text);
      break;
    case 'auth_url':
      showAuthUrl(msg.url);
      break;
    case 'auth_done':
      if (msg.success) showToast('✅ Autenticazione completata!', 'success');
      else showToast('❌ Autenticazione fallita', 'error');
      document.getElementById('btnStartAuth').disabled = false;
      document.getElementById('btnStartAuth').textContent = 'Riprova';
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

function detectUrlType() {
  const url = urlInput.value.trim();
  const wrap = document.getElementById('typeBadgeWrap');
  const badge = document.getElementById('typeBadge');

  if (!url) { wrap.style.display = 'none'; return; }

  let icon = '', label = '', type = '';
  if (url.includes('/album/'))    { icon = '💿'; label = 'Album';    type = 'Album'; }
  else if (url.includes('/track/'))    { icon = '🎵'; label = 'Traccia';  type = 'Traccia'; }
  else if (url.includes('/playlist/')) { icon = '📋'; label = 'Playlist'; type = 'Playlist'; }
  else if (url.includes('/video/'))    { icon = '🎬'; label = 'Video';    type = 'Video'; }
  else if (url.includes('/artist/'))   { icon = '🎤'; label = 'Artista';  type = 'Artista'; }
  else if (url.includes('tidal.com'))  { icon = '🎧'; label = 'Link TIDAL'; type = ''; }
  else { wrap.style.display = 'none'; return; }

  badge.textContent = `${icon} ${label}`;
  badge.className = `type-badge ${type}`;
  wrap.style.display = 'block';
}

// ── Paste from clipboard ───────────────────────────────────
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
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
    if (data.path) {
      document.getElementById('downloadPath').value = data.path;
    }
  } catch (err) {
    showToast('Errore durante la selezione della cartella', 'error');
  }
}

// ── Start Download ─────────────────────────────────────────
async function startDownload(overrideUrl) {
  const url          = overrideUrl || document.getElementById('tidalUrl').value.trim();
  const quality      = document.getElementById('quality').value;
  const downloadPath = document.getElementById('downloadPath').value.trim();
  const template     = document.getElementById('template').value.trim();
  const saveCovers   = document.getElementById('saveCovers').checked;

  if (!url) { showToast('Inserisci un URL TIDAL', 'error'); urlInput.focus(); return; }
  if (!url.includes('tidal.com')) { showToast('URL non valido: deve essere tidal.com', 'error'); return; }

  const btn = document.getElementById('btnDownload');
  const btnText = document.getElementById('btnDownloadText');
  if (!overrideUrl) {
    btn.disabled = true;
    btnText.textContent = 'Avvio in corso…';
  }

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality, downloadPath, template, saveCovers })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore server');

    if (!overrideUrl) {
      urlInput.value = '';
      document.getElementById('typeBadgeWrap').style.display = 'none';
    }
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  } finally {
    if (!overrideUrl) {
      btn.disabled = false;
      btnText.textContent = 'Avvia Download';
    }
  }
}

// ── Download from search result ────────────────────────────
function downloadFromSearch(url, name) {
  showToast(`⬇ Download: ${name}`, 'info');
  startDownload(url);
}

// ── Search ─────────────────────────────────────────────────
let searchFilter = 'all';
let searchDebounce;

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

  if (!q) {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>Cerca un artista o album per iniziare</p></div>`;
    return;
  }

  results.innerHTML = '';
  loading.style.display = 'flex';

  try {
    let typeParam = '';
    if (searchFilter === 'artists') typeParam = 'artists';
    else if (searchFilter === 'albums') typeParam = 'albums';
    else if (searchFilter === 'tracks') typeParam = 'tracks';

    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${typeParam ? `&type=${typeParam}` : ''}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Errore ricerca');

    loading.style.display = 'none';
    renderSearchResults(data);
  } catch (err) {
    loading.style.display = 'none';
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><p>${escHtml(err.message)}</p></div>`;
  }
}

function renderSearchResults(data) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  const hasArtists = data.artists && data.artists.length > 0;
  const hasAlbums = data.albums && data.albums.length > 0;
  const hasTracks = data.tracks && data.tracks.length > 0;

  if (!hasArtists && !hasAlbums && !hasTracks) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p>Nessun risultato trovato</p></div>`;
    return;
  }

  // Artists
  if (hasArtists && (searchFilter === 'all' || searchFilter === 'artists')) {
    const section = document.createElement('div');
    section.className = 'result-section';
    section.innerHTML = `
      <div class="result-section-title">🎤 Artisti <span class="result-section-count">${data.artists.length}</span></div>
      <div class="result-grid">
        ${data.artists.map(a => `
          <div class="result-card artist" onclick="downloadFromSearch('${escAttr(a.url)}', '${escAttr(a.name)}')">
            ${a.picture
              ? `<img class="result-cover" src="${a.picture}" alt="${escAttr(a.name)}" loading="lazy" onerror="this.outerHTML='<div class=\\'result-cover-placeholder\\'>🎤</div>'" />`
              : `<div class="result-cover-placeholder">🎤</div>`
            }
            <div class="result-body">
              <div class="result-title">${escHtml(a.name)}</div>
              <button class="result-dl-btn" onclick="event.stopPropagation(); downloadFromSearch('${escAttr(a.url)}', '${escAttr(a.name)}')">⬇ Scarica discografia</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(section);
  }

  // Albums
  if (hasAlbums && (searchFilter === 'all' || searchFilter === 'albums')) {
    const section = document.createElement('div');
    section.className = 'result-section';
    section.innerHTML = `
      <div class="result-section-title">💿 Album <span class="result-section-count">${data.albums.length}</span></div>
      <div class="result-grid">
        ${data.albums.map(a => `
          <div class="result-card" onclick="downloadFromSearch('${escAttr(a.url)}', '${escAttr(a.title)}')">
            ${a.cover
              ? `<img class="result-cover" src="${a.cover}" alt="${escAttr(a.title)}" loading="lazy" onerror="this.outerHTML='<div class=\\'result-cover-placeholder\\'>💿</div>'" />`
              : `<div class="result-cover-placeholder">💿</div>`
            }
            <div class="result-body">
              <div class="result-title">${escHtml(a.title)}</div>
              <div class="result-artist">${escHtml(a.artist)}</div>
              <div class="result-meta">
                ${a.year ? `<span>${a.year}</span>` : ''}
                ${a.tracks ? `<span>${a.tracks} tracce</span>` : ''}
              </div>
              <button class="result-dl-btn" onclick="event.stopPropagation(); downloadFromSearch('${escAttr(a.url)}', '${escAttr(a.title)}')">⬇ Scarica album</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(section);
  }

  // Tracks
  if (hasTracks && (searchFilter === 'all' || searchFilter === 'tracks')) {
    const section = document.createElement('div');
    section.className = 'result-section';
    section.innerHTML = `
      <div class="result-section-title">🎵 Tracce <span class="result-section-count">${data.tracks.length}</span></div>
      <div class="result-grid">
        ${data.tracks.map(t => `
          <div class="result-card" onclick="downloadFromSearch('${escAttr(t.url)}', '${escAttr(t.title)}')">
            ${t.cover
              ? `<img class="result-cover" src="${t.cover}" alt="${escAttr(t.title)}" loading="lazy" onerror="this.outerHTML='<div class=\\'result-cover-placeholder\\'>🎵</div>'" />`
              : `<div class="result-cover-placeholder">🎵</div>`
            }
            <div class="result-body">
              <div class="result-title">${escHtml(t.title)}</div>
              <div class="result-artist">${escHtml(t.artist)}</div>
              <div class="result-meta">
                ${t.album ? `<span>${escHtml(t.album)}</span>` : ''}
                ${t.duration ? `<span>${formatDuration(t.duration)}</span>` : ''}
              </div>
              <button class="result-dl-btn" onclick="event.stopPropagation(); downloadFromSearch('${escAttr(t.url)}', '${escAttr(t.title)}')">⬇ Scarica traccia</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(section);
  }
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Active downloads ───────────────────────────────────────
const activeMap = {};

function addActiveDownload(data) {
  activeMap[data.id] = { entry: data, logs: [] };
  renderActiveSection();
  loadHistory();
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

function finalizeDownload(id, status, error) {
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
        statusEl.innerHTML = '✅ Completato';
        el.querySelector('.progress-fill').style.width = '100%';
      } else {
        statusEl.className = 'dl-status error';
        statusEl.innerHTML = '❌ Errore';
      }
      const sp = el.querySelector('.status-spinner');
      if (sp) sp.remove();
    }
    setTimeout(() => {
      const pw = el.querySelector('.progress-wrap');
      if (pw) pw.style.opacity = '0.4';
    }, 2000);
  }

  if (status === 'done') showToast('✅ Download completato!', 'success');
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
    const { entry } = activeMap[id];
    container.appendChild(buildDownloadItem(entry, true));
  });
}

// ── History ────────────────────────────────────────────────
async function loadHistory() {
  const res = await fetch('/api/history');
  const history = await res.json();
  const list = document.getElementById('historyList');

  const histItems = history.filter(h => !activeMap[h.id]);

  if (histItems.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>Nessun download ancora</p></div>`;
    return;
  }

  list.innerHTML = '';
  histItems.forEach(item => list.appendChild(buildDownloadItem(item, false)));
}

function clearHistory() {
  document.getElementById('historyList').innerHTML =
    `<div class="empty-state"><div class="empty-icon">🎵</div><p>Nessun download ancora</p></div>`;
  showToast('Storico cancellato', 'info');
}

// ── Build download item DOM ────────────────────────────────
function buildDownloadItem(entry, isActive) {
  const el = document.createElement('div');
  el.className = 'dl-item';
  el.id = `dl-${entry.id}`;

  const statusCls = entry.status === 'done' ? 'done' : entry.status === 'error' ? 'error' : 'running';
  const statusIcon = entry.status === 'done' ? '✅ Completato' : entry.status === 'error' ? '❌ Errore' : '';
  const spinnerHtml = isActive && entry.status === 'running' ? '<div class="status-spinner"></div>' : '';

  const progress = entry.progress || 0;
  const time = entry.startTime ? new Date(entry.startTime).toLocaleTimeString('it-IT') : '';
  const shortUrl = entry.url.length > 55 ? entry.url.slice(0, 52) + '…' : entry.url;

  el.innerHTML = `
    <div class="dl-header">
      <div class="dl-info">
        <span class="dl-type ${entry.type}">${entry.type || '?'}</span>
        <div class="dl-url" title="${entry.url}">${shortUrl}</div>
        ${isActive ? `<div class="dl-last-log" style="font-size:11px;color:var(--text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%"></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="dl-status ${statusCls}">
          ${spinnerHtml}
          ${statusIcon || (isActive ? 'In corso…' : entry.status)}
        </div>
        <div class="dl-actions">
          <button class="dl-btn" onclick="openLogModal('${entry.id}')">Log</button>
        </div>
      </div>
    </div>
    ${isActive ? `
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>
    ` : ''}
    <div class="dl-time">${entry.quality !== 'auto' ? `Qualità: ${entry.quality} · ` : ''}${time}</div>
  `;

  return el;
}

// ── Log Modal ──────────────────────────────────────────────
let currentLogId = null;

function openLogModal(id) {
  currentLogId = id;
  const modal = document.getElementById('logModal');
  const content = document.getElementById('logContent');
  const title = document.getElementById('logModalTitle');

  const active = activeMap[id];
  let logs = [];
  let entry = null;

  if (active) {
    logs = active.logs;
    entry = active.entry;
  }

  title.textContent = `Log — ${entry ? entry.type + ' · ' + (entry.url.slice(0, 40) + '…') : id}`;

  content.innerHTML = logs.length === 0
    ? '<span style="color:var(--text-muted)">Nessun log disponibile</span>'
    : logs.map(l => `<div class="${l.isErr ? 'log-line-err' : ''}">${escHtml(l.text)}</div>`).join('');

  content.scrollTop = content.scrollHeight;
  modal.style.display = 'flex';
}

function appendLogLine(text, isErr) {
  const content = document.getElementById('logContent');
  const line = document.createElement('div');
  if (isErr) line.className = 'log-line-err';
  line.textContent = text;
  content.appendChild(line);
  content.scrollTop = content.scrollHeight;
}

function closeLogModal(e) {
  if (!e || e.target === document.getElementById('logModal') || e.currentTarget === undefined) {
    document.getElementById('logModal').style.display = 'none';
    currentLogId = null;
  }
}

// ── Auth Modal ─────────────────────────────────────────────
function openAuthModal() {
  document.getElementById('authLog').textContent = '';
  document.getElementById('authUrlBox').style.display = 'none';
  document.getElementById('btnStartAuth').disabled = false;
  document.getElementById('btnStartAuth').innerHTML = '<span class="btn-icon">🔐</span> Avvia Autenticazione<div class="btn-shimmer"></div>';
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
  window.open(url, '_blank');
}

async function startAuth() {
  const btn = document.getElementById('btnStartAuth');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Autenticazione in corso…<div class="btn-shimmer"></div>';
  document.getElementById('authLog').textContent = '';
  document.getElementById('authUrlBox').style.display = 'none';

  try {
    await fetch('/api/auth', { method: 'POST' });
  } catch (err) {
    showToast('Errore avvio auth: ' + err.message, 'error');
    btn.disabled = false;
  }
}

// ── Auth Status Check ──────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    const btn = document.getElementById('btnAuth');
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
  toastTimer = setTimeout(() => toast.className = 'toast', 3500);
}

// ── Helpers ────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Allow Enter key to trigger download
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});

// ── Init ───────────────────────────────────────────────────
connectWS();
loadHistory();
checkAuthStatus();

