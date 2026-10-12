// ════════════════════════════════════════════════════════════
//  tiddl GUI — interfaccia
// ════════════════════════════════════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

function fmtDuration(secs) {
  secs = Math.round(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLong(secs) {
  const m = Math.round((secs || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const albumKind = (t) => ({ ALBUM: 'Album', EP: 'EP', SINGLE: 'Singolo', COMPILATION: 'Compilation' }[t] || 'Album');

// ── Toast ────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', type === 'error' ? 6000 : 3200);
}

// ── Copertine: dissolvenza al caricamento e segnaposto se mancano ──
document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('loaded'); }, true);
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);

function coverHtml(src, icon = '🎵', extra = '') {
  return `<div class="cover ${extra}" data-icon="${icon}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}</div>`;
}

// ════════════════════════════════════════════════════════════
//  Impostazioni (ricordate nel browser)
// ════════════════════════════════════════════════════════════
const SETTINGS_KEY = 'tiddl-gui-settings-v2';
const settingFields = ['quality', 'downloadPath', 'template'];
const settingToggles = ['saveCovers', 'includeSingles'];

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    settingFields.forEach(f => { if (typeof s[f] === 'string') $('#' + f).value = s[f]; });
    settingToggles.forEach(f => { if (typeof s[f] === 'boolean') $('#' + f).checked = s[f]; });
  } catch {}
}
function saveSettings() {
  try {
    const s = {};
    settingFields.forEach(f => s[f] = $('#' + f).value);
    settingToggles.forEach(f => s[f] = $('#' + f).checked);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}
[...settingFields, ...settingToggles].forEach(f => $('#' + f).addEventListener('change', saveSettings));

function settings() {
  return {
    quality: $('#quality').value,
    downloadPath: $('#downloadPath').value.trim(),
    template: $('#template').value.trim(),
    saveCovers: $('#saveCovers').checked,
    includeSingles: $('#includeSingles').checked
  };
}

$('#btnBrowse').addEventListener('click', async () => {
  const btn = $('#btnBrowse');
  btn.disabled = true;
  toast('Scegli la cartella nella finestra che si è aperta…', 'info');
  try {
    const start = $('#downloadPath').value.trim();
    const data = await api('/api/browse' + (start ? `?start=${encodeURIComponent(start)}` : ''));
    if (data.unsupported) toast('La finestra "Sfoglia" funziona solo su Mac: scrivi il percorso a mano', 'info');
    else if (data.path) {
      $('#downloadPath').value = data.path;
      saveSettings();
      toast('📁 I download andranno in ' + data.path, 'success');
    }
  } catch (err) { toast('❌ ' + err.message, 'error'); }
  finally { btn.disabled = false; }
});

$('#btnOpenFolder').addEventListener('click', () => openFolder($('#downloadPath').value.trim()));

async function openFolder(p) {
  try { await api('/api/open-folder', { method: 'POST', body: { path: p } }); }
  catch (err) { toast('📁 ' + err.message, 'error'); }
}

// ════════════════════════════════════════════════════════════
//  Download
// ════════════════════════════════════════════════════════════
async function download({ urls, meta, singles, button }) {
  const s = settings();
  if (button) { button.disabled = true; }
  try {
    await api('/api/download', {
      method: 'POST',
      body: {
        urls, meta, singles,
        quality: s.quality, downloadPath: s.downloadPath, template: s.template, saveCovers: s.saveCovers
      }
    });
    toast(`⬇ In download: ${meta?.title || 'elemento'}`, 'info');
    if (button) {
      if (button.classList.contains('btn-primary')) {
        // pulsante grande: conferma e poi torna come prima
        const label = button.innerHTML;
        button.innerHTML = '✓ Aggiunto ai download';
        setTimeout(() => { button.innerHTML = label; button.disabled = false; }, 2500);
      } else { button.classList.add('done'); button.textContent = '✓'; }
    }
    return true;
  } catch (err) {
    toast('❌ ' + err.message, 'error');
    if (button) button.disabled = false;
    return false;
  }
}

const dlTrack = (t, button) => download({
  urls: [t.url], button,
  meta: { kind: 'track', title: t.title, subtitle: t.artist, cover: t.cover, totalTracks: 1 }
});

const dlAlbum = (a, button) => download({
  urls: [a.url], button,
  meta: {
    kind: 'album', title: a.title, subtitle: [a.artist, a.year].filter(Boolean).join(' · '),
    cover: a.cover, totalTracks: a.tracks, albums: [{ title: a.title, cover: a.cover, tracks: a.tracks }]
  }
});

const dlPlaylist = (p, button) => download({
  urls: [p.url], button,
  meta: { kind: 'playlist', title: p.title, subtitle: p.creator ? `Playlist di ${p.creator}` : 'Playlist', cover: p.cover, totalTracks: p.tracks }
});

function dlDiscography(data, button) {
  const withSingles = settings().includeSingles;
  const albums = withSingles ? [...data.albums, ...data.singles] : data.albums;
  if (!albums.length) {
    toast(withSingles ? 'Questo artista non ha uscite da scaricare' : 'Nessun album: attiva "EP e singoli nella discografia" nelle impostazioni', 'info');
    if (button) button.disabled = false;
    return false;
  }
  return download({
    urls: [data.artist.url], button, singles: withSingles ? 'include' : 'none',
    meta: {
      kind: 'artist', title: `${data.artist.name} — discografia`,
      subtitle: plural(albums.length, 'uscita', 'uscite') + (withSingles ? ' (con EP e singoli)' : ''),
      cover: data.artist.picture, totalTracks: albums.reduce((n, a) => n + (a.tracks || 0), 0),
      albums: albums.map(a => ({ title: a.title, cover: a.cover, tracks: a.tracks }))
    }
  });
}

function dlAlbumList(albums, title, cover) {
  if (!albums.length) return;
  if (albums.length === 1) return dlAlbum(albums[0]);
  return download({
    urls: albums.map(a => a.url),
    meta: {
      kind: 'selection', title, subtitle: plural(albums.length, 'album', 'album'), cover: cover || albums[0].cover,
      totalTracks: albums.reduce((n, a) => n + (a.tracks || 0), 0),
      albums: albums.map(a => ({ title: a.title, cover: a.cover, tracks: a.tracks }))
    }
  });
}

// ── Link incollato ───────────────────────────────────────────
function parseTidalUrl(str) {
  try {
    const u = new URL(str.trim());
    if (!/(^|\.)tidal\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(album|track|playlist|artist|video|mix)\/([\w-]+)/);
    return m ? { type: m[1], id: m[2], url: str.trim() } : null;
  } catch { return null; }
}

const TYPE_LABEL = { album: '💿 Album', track: '🎵 Brano', playlist: '📋 Playlist', artist: '🎤 Artista', video: '🎬 Video', mix: '🎛️ Mix' };

$('#tidalUrl').addEventListener('input', () => {
  const p = parseTidalUrl($('#tidalUrl').value);
  const b = $('#typeBadge');
  b.style.display = p ? '' : 'none';
  if (p) b.textContent = TYPE_LABEL[p.type];
});
$('#tidalUrl').addEventListener('keydown', e => { if (e.key === 'Enter') downloadFromUrl(); });
$('#btnDownloadUrl').addEventListener('click', downloadFromUrl);
$('#btnPaste').addEventListener('click', async () => {
  try {
    $('#tidalUrl').value = (await navigator.clipboard.readText()).trim();
    $('#tidalUrl').dispatchEvent(new Event('input'));
  } catch { toast('Incolla con Cmd+V nel campo', 'info'); $('#tidalUrl').focus(); }
});

async function downloadFromUrl() {
  const raw = $('#tidalUrl').value.trim();
  const p = parseTidalUrl(raw);
  if (!raw) { toast('Incolla prima un link di TIDAL', 'info'); return $('#tidalUrl').focus(); }
  if (!p) return toast('Il link non sembra di TIDAL (tidal.com/…)', 'error');
  const btn = $('#btnDownloadUrl');
  btn.disabled = true;
  let ok = false;
  try {
    // Recupera titolo e copertina per mostrarli nella coda
    if (p.type === 'album') ok = await dlAlbum((await api(`/api/album/${p.id}`)).album);
    else if (p.type === 'playlist') ok = await dlPlaylist((await api(`/api/playlist/${p.id}`)).playlist);
    else if (p.type === 'track') ok = await dlTrack(await api(`/api/track/${p.id}`));
    else if (p.type === 'artist') ok = await dlDiscography(await api(`/api/artist/${p.id}`));
    else ok = await download({ urls: [raw] });
  } catch {
    ok = await download({ urls: [raw] });
  }
  btn.disabled = false;
  if (ok) { $('#tidalUrl').value = ''; $('#typeBadge').style.display = 'none'; }
}

// ════════════════════════════════════════════════════════════
//  Navigazione (con il tasto "indietro" del browser)
// ════════════════════════════════════════════════════════════
const view = $('#view');
let currentData = null;      // dati della vista corrente (per la selezione)
let lastSearch = null;       // { q, types, data }

window.addEventListener('hashchange', route);

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

async function route() {
  clearSelection();
  const h = decodeURIComponent(location.hash.slice(1));
  const [kind, ...rest] = h.split('/');
  const arg = rest.join('/');
  window.scrollTo({ top: 0 });
  if (kind === 'artist' && arg) return showArtist(arg);
  if (kind === 'album' && arg) return showAlbum(arg);
  if (kind === 'playlist' && arg) return showPlaylist(arg);
  if (kind === 'search' && arg) {
    if ($('#searchQuery').value.trim() !== arg) { $('#searchQuery').value = arg; updateClear(); }
    return runSearch(arg);
  }
  showHome();
}

function backButton() {
  return lastSearch ? `<button class="back-btn" data-back>← Torna ai risultati per “${esc(lastSearch.q)}”</button>` : '';
}

view.addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) { history.length > 1 ? history.back() : go(`#search/${encodeURIComponent(lastSearch.q)}`); }
});

let featured = null;
async function getFeatured() {
  if (featured) return featured;
  try { featured = await api('/api/featured'); } catch { featured = []; }
  return featured;
}

async function showHome() {
  currentData = null;
  view.innerHTML = `
    <div class="home-intro">
      <h1>Cosa ascoltiamo oggi?</h1>
      <p>Cerca un artista, un album o un brano. Oppure parti dai grandi: premi <span class="inline-fab">⬇</span> su un artista per scaricare tutta la sua discografia.</p>
    </div>
    <div id="featured"><div class="artist-row">${Array.from({ length: 6 }, () => '<div class="artist-tile"><div class="skeleton sk-tile" style="border-radius:50%"></div><div class="skeleton sk-line"></div></div>').join('')}</div></div>`;
  const genres = await getFeatured();
  const box = $('#featured');
  if (!box) return; // nel frattempo l'utente ha cambiato pagina
  if (!genres.length) {
    box.innerHTML = `<div class="empty"><p>Non riesco a caricare la vetrina degli artisti: controlla di essere collegato a TIDAL. La ricerca funziona comunque.</p></div>`;
    return;
  }
  box.innerHTML = genres.map(g => section(esc(g.genre), '', `<div class="artist-row">${g.artists.map(artistTile).join('')}</div>`)).join('');
}

function showError(err) {
  view.innerHTML = `${backButton()}<div class="empty error-box"><div class="empty-icon">⚠️</div><h2>Qualcosa non va</h2><p>${esc(err.message)}</p></div>`;
}

function skeleton(withHero) {
  view.innerHTML = `
    ${withHero ? '<div class="skeleton sk-hero"></div>' : ''}
    <div class="grid">${Array.from({ length: 10 }, () => '<div><div class="skeleton sk-tile"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:50%"></div></div>').join('')}</div>`;
}

// ════════════════════════════════════════════════════════════
//  Ricerca
// ════════════════════════════════════════════════════════════
const searchInput = $('#searchQuery');
let searchTimer, searchSeq = 0;

function activeTypes() { return $$('#filterChips .chip.active').map(c => c.dataset.type); }

function updateClear() { $('#searchClear').style.display = searchInput.value ? '' : 'none'; }

searchInput.addEventListener('input', () => {
  updateClear();
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) return;
  searchTimer = setTimeout(() => {
    const hash = `#search/${encodeURIComponent(q)}`;
    // mentre scrivi non riempiamo la cronologia: sostituiamo la voce corrente
    if (location.hash.startsWith('#search/')) { history.replaceState(null, '', hash); route(); }
    else go(hash);
  }, 350);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); const q = searchInput.value.trim(); if (q) go(`#search/${encodeURIComponent(q)}`); }
  if (e.key === 'Escape') searchInput.blur();
});
$('#searchClear').addEventListener('click', () => { searchInput.value = ''; updateClear(); searchInput.focus(); });

$('#filterChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  chip.classList.toggle('active');
  if (!activeTypes().length) chip.classList.add('active');
  const q = searchInput.value.trim();
  if (q && location.hash.startsWith('#search/')) { lastSearch = null; runSearch(q); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (e.key === 'Escape') { closeModal('logModal'); closeModal('authModal'); clearSelection(); }
});

async function runSearch(q) {
  const types = activeTypes().join(',');
  if (lastSearch && lastSearch.q === q && lastSearch.types === types) return renderResults(lastSearch.data);
  const seq = ++searchSeq;
  skeleton(false);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&types=${types}&limit=24`);
    if (seq !== searchSeq) return;
    lastSearch = { q, types, data };
    renderResults(data);
  } catch (err) { if (seq === searchSeq) showError(err); }
}

function renderResults(data) {
  currentData = { kind: 'search', data };
  const t = activeTypes();
  const parts = [];

  if (t.includes('artist') && data.artists.length) {
    parts.push(section('Artisti', data.artists.length, `<div class="artist-row">${data.artists.map(artistTile).join('')}</div>`));
  }
  if (t.includes('track') && data.tracks.length) {
    parts.push(section('Brani', data.tracks.length, `<div class="tracks">${data.tracks.map((tr, i) => trackRow(tr, i, { cover: true, num: false })).join('')}</div>`));
  }
  if (t.includes('album') && data.albums.length) {
    parts.push(section('Album', data.albums.length, `<div class="grid">${data.albums.map((a, i) => albumTile(a, i)).join('')}</div>`));
  }
  if (t.includes('playlist') && data.playlists.length) {
    parts.push(section('Playlist', data.playlists.length, `<div class="grid">${data.playlists.map((p, i) => playlistTile(p, i)).join('')}</div>`));
  }
  view.innerHTML = parts.length ? parts.join('') :
    `<div class="empty"><div class="empty-icon">😕</div><h2>Nessun risultato</h2><p>Prova con un'altra parola o attiva più filtri.</p></div>`;
}

function section(title, count, body, extra = '') {
  return `<div class="section"><div class="section-head"><h2 class="section-title">${title}<span class="section-count">${count}</span></h2>${extra}</div>${body}</div>`;
}

// ── Componenti ───────────────────────────────────────────────
function qBadge(q, inline) {
  if (!q) return '';
  return `<span class="q-badge ${q === 'Lossless' ? 'lossless' : ''} ${inline ? 'inline' : ''}">${q === 'Hi-Res' ? 'HI-RES' : q.toUpperCase()}</span>`;
}

function artistTile(a) {
  return `<div class="artist-tile" data-artist="${a.id}" tabindex="0" title="Apri ${esc(a.name)}">
    <div class="artist-cover">
      ${coverHtml(a.picture, '🎤', 'round')}
      <button class="fab disco-fab" data-disco="${a.id}" title="Scarica la discografia di ${esc(a.name)}">⬇</button>
    </div>
    <div class="tile-title">${esc(a.name)}</div>
    <div class="tile-sub disco-hint">Discografia</div>
  </div>`;
}

async function dlDiscographyById(id, button) {
  button.disabled = true;
  button.classList.add('busy');
  try {
    const data = await api(`/api/artist/${encodeURIComponent(id)}`);
    button.classList.remove('busy');
    await dlDiscography(data, button);
  } catch (err) {
    toast('❌ ' + err.message, 'error');
    button.disabled = false;
  }
  button.classList.remove('busy');
}

function albumTile(a, i, opts = {}) {
  const sub = opts.artistView
    ? [a.year, albumKind(a.type) !== 'Album' ? albumKind(a.type) : '', a.tracks ? plural(a.tracks, 'brano', 'brani') : ''].filter(Boolean).join(' · ')
    : [a.artist, a.year].filter(Boolean).join(' · ');
  return `<div class="tile" data-kind="album" data-i="${i}" ${opts.list ? `data-list="${opts.list}"` : ''} tabindex="0">
    <div style="position:relative">
      ${coverHtml(a.cover, '💿')}
      <div class="badges">${qBadge(a.quality)}</div>
      ${opts.selectable ? '<button class="select-dot" data-select title="Seleziona">✓</button>' : ''}
      <div class="tile-actions"><button class="fab" data-dl title="Scarica album">⬇</button></div>
    </div>
    <div class="tile-title" title="${esc(a.title)}">${esc(a.title)}${a.explicit ? '<span class="explicit">E</span>' : ''}</div>
    <div class="tile-sub">${esc(sub)}</div>
  </div>`;
}

function playlistTile(p, i) {
  return `<div class="tile" data-kind="playlist" data-i="${i}" tabindex="0">
    <div style="position:relative">
      ${coverHtml(p.cover, '📋')}
      <div class="tile-actions"><button class="fab" data-dl title="Scarica playlist">⬇</button></div>
    </div>
    <div class="tile-title">${esc(p.title)}</div>
    <div class="tile-sub">${esc([p.creator, p.tracks ? plural(p.tracks, 'brano', 'brani') : ''].filter(Boolean).join(' · '))}</div>
  </div>`;
}

function trackRow(t, i, { cover = true, num = true, showAlbum = true } = {}) {
  const sub = [
    t.artistId ? `<a href="#artist/${t.artistId}">${esc(t.artist)}</a>` : esc(t.artist),
    showAlbum && t.album ? (t.albumId ? `<a href="#album/${t.albumId}">${esc(t.album)}</a>` : esc(t.album)) : ''
  ].filter(Boolean).join(' · ');
  return `<div class="track ${cover ? '' : 'no-cover'} ${num ? '' : 'no-num'}" data-kind="track" data-i="${i}">
    ${num ? `<span class="num">${t.number || i + 1}</span>` : ''}
    ${cover ? coverHtml(t.cover, '🎵') : ''}
    <div class="track-main">
      <div class="track-title" title="${esc(t.title)}">${esc(t.title)}${t.explicit ? '<span class="explicit">E</span>' : ''}</div>
      <div class="track-sub">${sub}</div>
    </div>
    <span class="q-col">${qBadge(t.quality, true)}</span>
    <span class="dur">${fmtDuration(t.duration)}</span>
    <button class="row-dl" data-dl title="Scarica brano">⬇</button>
  </div>`;
}

// Click su copertine, brani e pulsanti di download
view.addEventListener('click', (e) => {
  const disco = e.target.closest('[data-disco]');
  if (disco) { e.preventDefault(); return dlDiscographyById(disco.dataset.disco, disco); }
  const at = e.target.closest('.artist-tile');
  if (at) return go(`#artist/${at.dataset.artist}`);
  if (e.target.closest('a')) return; // link a artista/album
  const el = e.target.closest('[data-kind]');
  if (!el || !currentData) return;
  const i = +el.dataset.i;
  const kind = el.dataset.kind;
  const item = pickItem(kind, i, el.dataset.list);
  if (!item) return;

  if (e.target.closest('[data-select]')) { e.stopPropagation(); return toggleSelect(el); }

  const dlBtn = e.target.closest('[data-dl]');
  if (dlBtn) {
    if (kind === 'album') return dlAlbum(item, dlBtn);
    if (kind === 'playlist') return dlPlaylist(item, dlBtn);
    if (kind === 'track') return dlTrack(item, dlBtn);
  }
  // In modalità "scegli album" il click seleziona invece di aprire
  if (kind === 'album' && el.dataset.list && (selection.size || el.closest('.selecting'))) return toggleSelect(el);
  if (kind === 'album') go(`#album/${item.id}`);
  else if (kind === 'playlist') go(`#playlist/${item.id}`);
});
view.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target.classList.contains('tile') || e.target.classList.contains('artist-tile'))) e.target.click();
});

function pickItem(kind, i, list) {
  const d = currentData.data;
  if (currentData.kind === 'search') return ({ album: d.albums, playlist: d.playlists, track: d.tracks }[kind] || [])[i];
  if (currentData.kind === 'artist') return kind === 'album' ? (d[list] || [])[i] : null;
  if (currentData.kind === 'album' || currentData.kind === 'playlist') return kind === 'track' ? d.tracks[i] : null;
  return null;
}

// ════════════════════════════════════════════════════════════
//  Artista
// ════════════════════════════════════════════════════════════
let artistTab = 'albums';

async function showArtist(id) {
  skeleton(true);
  try {
    const data = await api(`/api/artist/${encodeURIComponent(id)}`);
    currentData = { kind: 'artist', data };
    if (!data[artistTab]?.length) artistTab = data.albums.length ? 'albums' : data.singles.length ? 'singles' : 'compilations';
    renderArtist();
  } catch (err) { showError(err); }
}

function renderArtist() {
  const { artist, albums, singles, compilations } = currentData.data;
  const total = albums.length + singles.length;
  const tabs = [['albums', 'Album', albums], ['singles', 'EP e singoli', singles], ['compilations', 'Appare in', compilations]].filter(t => t[2].length);
  const list = currentData.data[artistTab] || [];

  view.innerHTML = `
    ${backButton()}
    <div class="hero">
      <div class="hero-bg" style="background-image:url('${esc(artist.pictureLarge || '')}')"></div>
      <div class="hero-inner">
        ${coverHtml(artist.pictureLarge, '🎤', 'round')}
        <div class="hero-text">
          <div class="hero-kind">Artista</div>
          <h1 class="hero-title">${esc(artist.name)}</h1>
          <div class="hero-sub">
            <span><strong>${albums.length}</strong> album</span>
            <span><strong>${singles.length}</strong> EP e singoli</span>
            ${compilations.length ? `<span><strong>${compilations.length}</strong> apparizioni</span>` : ''}
          </div>
          <div class="hero-actions">
            <button class="btn-primary" id="btnDiscography" ${total ? '' : 'disabled'}>⬇ Scarica discografia</button>
            <button class="btn-ghost" id="btnSelectMode">☑️ Scegli album</button>
          </div>
        </div>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, label, arr]) => `<button class="tab ${k === artistTab ? 'active' : ''}" data-tab="${k}">${label}<span class="n">${arr.length}</span></button>`).join('')}</div>
    <div class="grid" id="artistGrid">${list.map((a, i) => albumTile(a, i, { artistView: true, selectable: true, list: artistTab })).join('')}</div>
    ${!list.length ? '<div class="empty"><p>Nessuna uscita trovata.</p></div>' : ''}`;

  $('#btnDiscography').addEventListener('click', (e) => dlDiscography(currentData.data, e.currentTarget));
  $('#btnSelectMode').addEventListener('click', () => {
    const grid = $('#artistGrid');
    const on = !grid.classList.contains('selecting');
    grid.classList.toggle('selecting', on);
    $('#btnSelectMode').classList.toggle('on', on);
    if (!on) clearSelection();
    else toast('Tocca le copertine per sceglierle, poi “Scarica selezionati”', 'info');
  });
  $$('.tab', view).forEach(t => t.addEventListener('click', () => {
    artistTab = t.dataset.tab;
    const selecting = $('#btnSelectMode').classList.contains('on');
    renderArtist();
    // la selezione resta valida anche cambiando scheda
    $$('#artistGrid .tile').forEach(el => { if (selection.has(selKey(el))) el.classList.add('selected'); });
    if (selecting) { $('#artistGrid').classList.add('selecting'); $('#btnSelectMode').classList.add('on'); }
    else if (selection.size) $('#artistGrid').classList.add('selecting');
    updateSelectionBar();
  }));
}

// ── Selezione multipla di album ──────────────────────────────
const selection = new Map();       // chiave -> album
const selectionItems = new Map();
const selKey = (el) => `${el.dataset.list}:${el.dataset.i}`;

function toggleSelect(el) {
  const key = selKey(el);
  const item = pickItem('album', +el.dataset.i, el.dataset.list);
  if (selection.has(key)) { selection.delete(key); el.classList.remove('selected'); }
  else { selection.set(key, item); selectionItems.set(key, item); el.classList.add('selected'); }
  $('#artistGrid')?.classList.toggle('selecting', selection.size > 0 || $('#btnSelectMode')?.classList.contains('on'));
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = selection.size;
  $('#selectionBar').classList.toggle('show', n > 0);
  if (n) {
    const tracks = [...selection.values()].reduce((s, a) => s + (a.tracks || 0), 0);
    $('#selectionText').textContent = `${plural(n, 'album selezionato', 'album selezionati')} · ${plural(tracks, 'brano', 'brani')}`;
  }
}

function clearSelection() {
  selection.clear();
  selectionItems.clear();
  $$('.tile.selected').forEach(el => el.classList.remove('selected'));
  if (!$('#btnSelectMode')?.classList.contains('on')) $('#artistGrid')?.classList.remove('selecting');
  updateSelectionBar();
}

$('#btnSelectNone').addEventListener('click', clearSelection);
$('#btnSelectAll').addEventListener('click', () => {
  $$('#artistGrid .tile').forEach(el => { if (!selection.has(selKey(el))) toggleSelect(el); });
});
$('#btnDownloadSelected').addEventListener('click', async () => {
  const albums = [...selection.values()];
  const artist = currentData?.data?.artist;
  const ok = await dlAlbumList(albums, artist ? `${artist.name} — ${plural(albums.length, 'album', 'album')}` : `${albums.length} album`, null);
  if (ok !== false) clearSelection();
});

// ════════════════════════════════════════════════════════════
//  Album e playlist
// ════════════════════════════════════════════════════════════
async function showAlbum(id) {
  skeleton(true);
  try {
    const data = await api(`/api/album/${encodeURIComponent(id)}`);
    currentData = { kind: 'album', data };
    const a = data.album;
    const volumes = new Set(data.tracks.map(t => t.volume)).size > 1;
    let lastVol = null;
    const rows = data.tracks.map((t, i) => {
      let head = '';
      if (volumes && t.volume !== lastVol) { lastVol = t.volume; head = `<div class="disc-head">Disco ${t.volume}</div>`; }
      return head + trackRow(t, i, { cover: false, showAlbum: false });
    }).join('');

    view.innerHTML = `
      ${backButton()}
      <div class="hero">
        <div class="hero-bg" style="background-image:url('${esc(a.coverLarge || '')}')"></div>
        <div class="hero-inner">
          ${coverHtml(a.coverLarge, '💿')}
          <div class="hero-text">
            <div class="hero-kind">${albumKind(a.type)}</div>
            <h1 class="hero-title">${esc(a.title)}</h1>
            <div class="hero-sub">
              ${a.artistId ? `<a href="#artist/${a.artistId}"><strong>${esc(a.artist)}</strong></a>` : `<strong>${esc(a.artist)}</strong>`}
              ${a.year ? `<span>${a.year}</span>` : ''}
              <span>${plural(a.tracks, 'brano', 'brani')}</span>
              ${a.duration ? `<span>${fmtLong(a.duration)}</span>` : ''}
              ${qBadge(a.quality, true)}
            </div>
            <div class="hero-actions">
              <button class="btn-primary" id="btnDlAlbum">⬇ Scarica ${albumKind(a.type).toLowerCase() === 'singolo' ? 'singolo' : 'album'}</button>
              ${a.artistId ? `<a class="btn-ghost" href="#artist/${a.artistId}">🎤 Altri album di ${esc(a.artist.split(',')[0])}</a>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="tracks">${rows}</div>`;
    $('#btnDlAlbum').addEventListener('click', (e) => dlAlbum(a, e.currentTarget));
  } catch (err) { showError(err); }
}

async function showPlaylist(id) {
  skeleton(true);
  try {
    const data = await api(`/api/playlist/${encodeURIComponent(id)}`);
    currentData = { kind: 'playlist', data };
    const p = data.playlist;
    view.innerHTML = `
      ${backButton()}
      <div class="hero">
        <div class="hero-bg" style="background-image:url('${esc(p.coverLarge || '')}')"></div>
        <div class="hero-inner">
          ${coverHtml(p.coverLarge, '📋')}
          <div class="hero-text">
            <div class="hero-kind">Playlist</div>
            <h1 class="hero-title">${esc(p.title)}</h1>
            <div class="hero-sub">
              ${p.creator ? `<strong>${esc(p.creator)}</strong>` : ''}
              <span>${plural(p.tracks, 'brano', 'brani')}</span>
              ${p.duration ? `<span>${fmtLong(p.duration)}</span>` : ''}
            </div>
            <div class="hero-actions"><button class="btn-primary" id="btnDlPlaylist">⬇ Scarica playlist</button></div>
          </div>
        </div>
      </div>
      <div class="tracks">${data.tracks.map((t, i) => trackRow(t, i, { cover: true, num: true })).join('')}</div>
      ${p.tracks > data.tracks.length ? `<p class="hint" style="text-align:center;margin-top:12px">Qui vedi i primi ${data.tracks.length} brani: “Scarica playlist” li scarica tutti e ${p.tracks}.</p>` : ''}`;
    $('#btnDlPlaylist').addEventListener('click', (e) => dlPlaylist(p, e.currentTarget));
  } catch (err) { showError(err); }
}

// ════════════════════════════════════════════════════════════
//  Coda dei download
// ════════════════════════════════════════════════════════════
const downloads = new Map();   // id -> entry (senza log)
const lastLine = new Map();    // id -> ultima riga di log

async function loadDownloads() {
  try {
    const list = await api('/api/history');
    downloads.clear();
    list.forEach(e => downloads.set(e.id, e));
    renderQueue();
  } catch {}
}

const TYPE_ICON = { Album: '💿', Traccia: '🎵', Playlist: '📋', Artista: '🎤', Video: '🎬', Mix: '🎛️', Selezione: '💿' };

function statusInfo(e) {
  if (e.status === 'running') {
    const total = e.meta?.totalTracks;
    return { cls: 'running', text: total ? `${e.itemsDone} di ${total} brani · ${e.progress}%` : (e.itemsDone ? plural(e.itemsDone, 'brano scaricato', 'brani scaricati') : 'Avvio…') };
  }
  if (e.status === 'done' && e.errorCount) return { cls: 'warn', text: `⚠️ Completato con ${plural(e.errorCount, 'errore', 'errori')}` };
  if (e.status === 'done') return { cls: 'done', text: `✓ Completato${e.itemsDone ? ` · ${plural(e.itemsDone, 'brano', 'brani')}` : ''}` };
  if (e.status === 'cancelled') return { cls: 'cancelled', text: 'Annullato' };
  return { cls: 'error', text: '✕ ' + (e.error || 'Errore') };
}

function mosaicHtml(e) {
  const albums = e.meta?.albums;
  if (!albums || albums.length < 2) return '';
  const max = 24;
  const cells = albums.slice(0, max).map(a => {
    const st = a.tracks && a.done >= a.tracks ? 'done' : a.done > 0 ? 'partial' : (e.status === 'done' ? 'done' : '');
    return `<div class="m ${st}" title="${esc(a.title)}${a.tracks ? ` — ${Math.min(a.done, a.tracks)}/${a.tracks}` : ''}">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : ''}</div>`;
  }).join('');
  return `<div class="mosaic">${cells}${albums.length > max ? `<div class="m more">+${albums.length - max}</div>` : ''}</div>`;
}

const seenInQueue = new Set();
function queueItemHtml(e) {
  const isNew = !seenInQueue.has(e.id);
  seenInQueue.add(e.id);
  const st = statusInfo(e);
  const title = e.meta?.title || e.url;
  const sub = [e.meta?.subtitle || e.type, e.quality && e.quality !== 'auto' ? qualityName(e.quality) : ''].filter(Boolean).join(' · ');
  const running = e.status === 'running';
  return `<div class="q-item ${e.status} ${isNew ? 'new' : ''}" data-id="${esc(e.id)}">
    <div class="q-top">
      ${coverHtml(e.meta?.cover, TYPE_ICON[e.type] || '🎧', e.meta?.kind === 'artist' ? 'round' : '')}
      <div class="q-body">
        <div class="q-title" title="${esc(title)}">${esc(title)}</div>
        <div class="q-sub">${esc(sub)}</div>
        <div class="q-status ${st.cls}" title="${esc(e.error || '')}">${running ? '<span class="spinner"></span>' : ''}<span>${esc(st.text)}</span></div>
      </div>
    </div>
    ${running ? `<div class="progress"><div class="progress-fill" style="width:${e.progress || 0}%"></div></div>` : ''}
    ${mosaicHtml(e)}
    ${running && lastLine.get(e.id) ? `<div class="q-last">${esc(lastLine.get(e.id))}</div>` : ''}
    <div class="q-actions">
      ${running ? '<button class="btn-text danger" data-act="cancel">Annulla</button>' : ''}
      ${!running && e.itemsDone ? '<button class="btn-text" data-act="open">📁 Apri cartella</button>' : ''}
      <button class="btn-text" data-act="log">Log</button>
    </div>
  </div>`;
}

const qualityName = (q) => ({ max: 'Hi-Res', high: 'Lossless', normal: 'AAC 320', low: 'AAC 96' }[q] || q);

function renderQueue() {
  const list = [...downloads.values()].sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
    return String(b.startTime).localeCompare(String(a.startTime));
  });
  $('#queue').innerHTML = list.length ? list.map(queueItemHtml).join('') :
    '<div class="q-empty">Qui compariranno i tuoi download.<br>Premi ⬇ su un album o un brano per iniziare.</div>';
  updateCounters();
}

function renderQueueItem(id) {
  const e = downloads.get(id);
  const old = $(`.q-item[data-id="${CSS.escape(id)}"]`);
  if (!e) return old?.remove();
  if (!old) return renderQueue();
  const tmp = document.createElement('div');
  tmp.innerHTML = queueItemHtml(e);
  old.replaceWith(tmp.firstElementChild);
}

function updateCounters() {
  const running = [...downloads.values()].filter(e => e.status === 'running').length;
  $('#queueCount').textContent = running ? `${running} in corso` : '';
  document.title = running ? `(${running}) ⬇ tiddl` : 'tiddl — TIDAL Downloader';
}

$('#queue').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.q-item').dataset.id;
  const e = downloads.get(id);
  if (btn.dataset.act === 'log') openLog(id);
  if (btn.dataset.act === 'open') openFolder(e.lastDir || e.path);
  if (btn.dataset.act === 'cancel') {
    try { await api(`/api/download/${id}/cancel`, { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
  }
});

$('#btnClearHistory').addEventListener('click', async () => {
  try { await api('/api/history', { method: 'DELETE' }); await loadDownloads(); toast('Storico svuotato', 'info'); }
  catch (err) { toast(err.message, 'error'); }
});

// ── Log ──────────────────────────────────────────────────────
let logId = null;
async function openLog(id) {
  logId = id;
  const e = downloads.get(id);
  $('#logModalTitle').textContent = `Log — ${e?.meta?.title || e?.url || ''}`;
  $('#logContent').innerHTML = '<span style="color:var(--text-muted)">Caricamento…</span>';
  openModal('logModal');
  try {
    const full = await api(`/api/download/${id}`);
    if (logId !== id) return;
    $('#logContent').innerHTML = full.logs.length
      ? full.logs.map(logLineHtml).join('')
      : '<span style="color:var(--text-muted)">Ancora nessun messaggio</span>';
    $('#logContent').scrollTop = 1e9;
  } catch (err) { $('#logContent').textContent = err.message; }
}
const logLineHtml = (l) => `<div class="${l.isErr ? 'log-line-err' : /^(Downloaded|Exists)\b/.test(l.text) ? 'log-line-ok' : ''}">${esc(l.text)}</div>`;

// ════════════════════════════════════════════════════════════
//  WebSocket: aggiornamenti in tempo reale
// ════════════════════════════════════════════════════════════
let ws, wsTimer;
function connectWS() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { setConn(true); loadDownloads(); };
  ws.onclose = () => { setConn(false); clearTimeout(wsTimer); wsTimer = setTimeout(connectWS, 2500); };
  ws.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } onEvent(d); };
}
function setConn(ok) {
  $('#statusDot').className = 'status-dot ' + (ok ? 'connected' : 'error');
  $('#statusText').textContent = ok ? 'Connesso' : 'Server non raggiungibile';
}

function onEvent(d) {
  switch (d.event) {
    case 'download_started':
      downloads.set(d.data.id, d.data);
      renderQueue();
      break;
    case 'download_log': {
      const e = downloads.get(d.id);
      if (!e) break;
      e.progress = d.progress; e.itemsDone = d.itemsDone; e.errorCount = d.errorCount;
      if (d.albumIndex >= 0 && e.meta?.albums?.[d.albumIndex]) e.meta.albums[d.albumIndex].done = d.albumDone;
      lastLine.set(d.id, d.text);
      renderQueueItem(d.id);
      if (logId === d.id) {
        const box = $('#logContent');
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        if (box.querySelector('span')) box.innerHTML = '';
        box.insertAdjacentHTML('beforeend', logLineHtml({ text: d.text, isErr: d.isErr }));
        if (atBottom) box.scrollTop = 1e9;
      }
      break;
    }
    case 'download_done': {
      downloads.set(d.id, d.data);
      lastLine.delete(d.id);
      renderQueue();
      const t = d.data.meta?.title || 'Download';
      if (d.status === 'done' && !d.data.errorCount) toast(`✅ ${t}: completato`, 'success');
      else if (d.status === 'done') toast(`⚠️ ${t}: completato con ${plural(d.data.errorCount, 'errore', 'errori')}`, 'info');
      else if (d.status === 'cancelled') toast(`${t}: annullato`, 'info');
      else toast(`❌ ${t}: ${d.error || 'errore'}`, 'error');
      break;
    }
    case 'auth_log': appendAuthLog(d.text); break;
    case 'auth_url': showAuthUrl(d.url); break;
    case 'auth_done': onAuthDone(d.success); break;
  }
}

// ════════════════════════════════════════════════════════════
//  Account TIDAL
// ════════════════════════════════════════════════════════════
let authed = false, authRunning = false, authWindow = null;

function openModal(id) { $('#' + id).style.display = 'flex'; }
function closeModal(id) { $('#' + id).style.display = 'none'; if (id === 'logModal') logId = null; }
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
$$('.modal-overlay').forEach(o => o.addEventListener('click', (e) => { if (e.target === o) closeModal(o.id); }));

async function checkAuth() {
  try {
    const s = await api('/api/auth-status');
    authed = s.authenticated;
    $('#btnAuth').classList.toggle('ok', authed);
    $('#authLabel').textContent = authed ? 'TIDAL collegato' : 'Accedi a TIDAL';
    if (!s.tiddlFound) toast('⚠️ tiddl non è installato su questo computer', 'error');
  } catch {}
}

$('#btnAuth').addEventListener('click', () => {
  if (!authRunning) {
    $('#authLog').style.display = 'none';
    $('#authLog').textContent = '';
    $('#authUrlBox').style.display = 'none';
  }
  $('#authDesc').textContent = authed
    ? 'Il tuo account TIDAL è collegato: puoi cercare e scaricare. Se vuoi usare un altro account, disconnettiti e accedi di nuovo.'
    : 'Per scaricare devi collegare il tuo account TIDAL. Si aprirà la pagina di TIDAL dove confermare l\'accesso.';
  $('#btnStartAuth').style.display = authed && !authRunning ? 'none' : '';
  $('#btnLogout').style.display = authed && !authRunning ? '' : 'none';
  openModal('authModal');
});

$('#btnStartAuth').addEventListener('click', async () => {
  const btn = $('#btnStartAuth');
  btn.disabled = true;
  btn.textContent = '⏳ In attesa della conferma su TIDAL…';
  $('#authLog').textContent = '';
  $('#authLog').style.display = '';
  authRunning = true;
  try { authWindow = window.open('about:blank', '_blank'); } catch { authWindow = null; }
  try { await api('/api/auth', { method: 'POST' }); }
  catch (err) {
    authRunning = false;
    try { authWindow?.close(); } catch {}
    appendAuthLog(err.message);
    btn.disabled = false;
    btn.textContent = '🔐 Accedi con TIDAL';
  }
});

$('#btnLogout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); toast('Account disconnesso', 'info'); }
  catch (err) { toast(err.message, 'error'); }
  await checkAuth();
  closeModal('authModal');
});

function appendAuthLog(text) {
  const el = $('#authLog');
  el.style.display = '';
  el.textContent += (el.textContent ? '\n' : '') + text;
  el.scrollTop = 1e9;
}
function showAuthUrl(url) {
  $('#authUrl').href = url;
  $('#authUrl').textContent = url;
  $('#authUrlBox').style.display = '';
  try { if (authWindow && !authWindow.closed) authWindow.location.href = url; } catch {}
}
function onAuthDone(success) {
  authRunning = false;
  const btn = $('#btnStartAuth');
  btn.disabled = false;
  btn.textContent = success ? '✅ Collegato' : '🔁 Riprova';
  if (!success) { try { if (authWindow && authWindow.location.href === 'about:blank') authWindow.close(); } catch {} }
  authWindow = null;
  toast(success ? '✅ Account TIDAL collegato' : '❌ Accesso non riuscito', success ? 'success' : 'error');
  checkAuth();
  if (success) setTimeout(() => closeModal('authModal'), 1200);
}

// ════════════════════════════════════════════════════════════
//  Sfondo: vinili con le foto dei grandi artisti
// ════════════════════════════════════════════════════════════
let vinylArtists = [];
async function buildVinylBackdrop() {
  const genres = await getFeatured();
  // alterna i generi così vicini ci sono artisti diversi
  const max = Math.max(0, ...genres.map(g => g.artists.length));
  vinylArtists = [];
  for (let i = 0; i < max; i++) genres.forEach(g => { if (g.artists[i]) vinylArtists.push(g.artists[i]); });
  if (!vinylArtists.length) return;
  layoutVinyls();
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(layoutVinyls, 250); });
}

// Griglia a nido d'ape: tutti i vinili uguali e alla stessa distanza dai vicini
function layoutVinyls() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const W = window.innerWidth, H = window.innerHeight;
  const size = W < 700 ? 230 : 340;
  const gap = W < 700 ? 22 : 30;
  const step = size + gap;                 // distanza tra i centri, sempre uguale
  const rowH = step * Math.sqrt(3) / 2;    // righe sfalsate (esagonale)
  const cols = Math.ceil(W / step) + 2;
  const rows = Math.ceil(H / rowH) + 2;
  const offX = (W - (cols - 1) * step) / 2;
  const offY = (H - (rows - 1) * rowH) / 2;
  let html = '', n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = vinylArtists[(r * 5 + c * 2 + Math.floor(r / 2)) % vinylArtists.length];
      const x = offX + c * step + (r % 2 ? step / 2 : 0) - size / 2;
      const y = offY + r * rowH - size / 2;
      const delay = ((r * 7 + c * 13) % 60);
      html += `<div class="vinyl" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${size}px;height:${size}px">
        <div class="disc" style="animation-delay:-${delay}s;${reduce ? 'animation:none' : ''}"><img src="${esc(a.picture)}" alt="" loading="lazy"></div>
        <div class="sheen"></div>
      </div>`;
      n++;
    }
  }
  $('#vinylBg').innerHTML = html;
}

// ════════════════════════════════════════════════════════════
//  Avvio
// ════════════════════════════════════════════════════════════
loadSettings();
api('/api/defaults').then(d => { $('#downloadPath').placeholder = d.downloadPath.replace(d.home, '~'); }).catch(() => {});
connectWS();
checkAuth();
route();
buildVinylBackdrop();
