const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync, execFile } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '1mb' }));
// no-cache: dopo un aggiornamento il browser carica subito la pagina nuova
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// ── Percorsi e ambiente ───────────────────────────────────
const HOME = os.homedir();
const TIDDL_DIR = process.env.TIDDL_PATH || path.join(HOME, '.tiddl');
const AUTH_FILE = path.join(TIDDL_DIR, 'auth.json');
const CONFIG_FILE = path.join(TIDDL_DIR, 'config.toml');
const HISTORY_FILE = path.join(TIDDL_DIR, 'gui-history.json');
const DEFAULT_DOWNLOAD_PATH = path.join(HOME, 'Music', 'tiddl');
const TIDAL_API = process.env.TIDAL_API || 'https://api.tidal.com/v1';
const PUBLIC_TOKEN = 'CzET4vdadNUFQ5JU';

const EXTRA_PATHS = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
];

const VALID_QUALITIES = ['low', 'normal', 'high', 'max'];
const VALID_SINGLES = ['none', 'include', 'only'];
const MAX_LOG_LINES = 3000;

function buildEnv() {
  return {
    ...process.env,
    PATH: [...EXTRA_PATHS, process.env.PATH || ''].join(path.delimiter),
    // Senza questo Python bufferizza l'output quando non è su un terminale
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Output di rich pulito e su righe lunghe (niente percorsi spezzati)
    NO_COLOR: '1',
    TERM: 'dumb',
    COLUMNS: '1000'
  };
}

// Trova l'eseguibile tiddl: variabile TIDDL_BIN, poi i percorsi noti, poi il PATH
function findTiddl() {
  if (process.env.TIDDL_BIN) return process.env.TIDDL_BIN;
  const dirs = [...EXTRA_PATHS, ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, 'tiddl');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function spawnTiddl(args, options = {}) {
  const bin = findTiddl();
  if (!bin) throw new Error('tiddl non trovato. Installalo (es. "pipx install tiddl") oppure imposta la variabile TIDDL_BIN.');
  return spawn(bin, args, { env: buildEnv(), ...options });
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function cleanLine(line) {
  return line
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd();
}

// Spezza uno stream in righe complete (gestisce chunk a metà riga e \r)
function lineReader(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString();
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      parts.forEach(p => { const l = cleanLine(p); if (l.trim()) onLine(l); });
    },
    flush() {
      const l = cleanLine(buf);
      buf = '';
      if (l.trim()) onLine(l);
    }
  };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Auth ──────────────────────────────────────────────────
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}

function runTiddlQuiet(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnTiddl(args); } catch { return resolve(false); }
    const t = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('close', code => { clearTimeout(t); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

let refreshing = null;
async function getAuth() {
  let auth = readAuth();
  if (!auth || !auth.token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (auth.expires_at && auth.expires_at - 300 < now) {
    refreshing = refreshing || runTiddlQuiet(['auth', 'refresh']).finally(() => { refreshing = null; });
    await refreshing;
    auth = readAuth();
  }
  return auth && auth.token ? auth : null;
}

// ── Config tiddl: aggiorna solo le sezioni della GUI ──────
function updateTiddlConfig(saveCovers) {
  const v = saveCovers ? 'true' : 'false';
  const managed = {
    'metadata': `enable = true\ncover = ${v}\nlyrics = ${v}`,
    'cover': `save = ${v}\nsize = 1280\nallowed = ["album", "track", "playlist"]`,
    'cover.templates': `album = "{album.artist}/{album.title}/cover"\ntrack = "{album.artist}/{album.title}/cover"\nplaylist = "{playlist.title}/cover"`
  };
  let existing = '';
  try { existing = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch {}
  const sections = [];
  let current = { name: null, lines: [] };
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\[\]]+)\]\s*(#.*)?$/);
    if (m) { sections.push(current); current = { name: m[1].trim(), lines: [line] }; }
    else current.lines.push(line);
  }
  sections.push(current);
  let out = sections.filter(s => !(s.name in managed))
    .map(s => s.lines.join('\n').replace(/\s+$/, '')).filter(Boolean).join('\n\n');
  for (const [name, body] of Object.entries(managed)) out += `${out ? '\n\n' : ''}[${name}]\n${body}`;
  fs.mkdirSync(TIDDL_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, out + '\n');
}

// ── TIDAL API ─────────────────────────────────────────────
function httpGetJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https:') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', ...headers },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('TIDAL non risponde (timeout)')));
    req.on('error', reject);
  });
}

async function tidal(endpoint, params = {}) {
  const auth = await getAuth();
  const qs = new URLSearchParams({ countryCode: (auth && auth.country_code) || 'IT', ...params });
  const headers = auth ? { Authorization: `Bearer ${auth.token}` } : { 'x-tidal-token': PUBLIC_TOKEN };
  const { status, json } = await httpGetJson(`${TIDAL_API}/${endpoint}?${qs}`, headers);
  if (status !== 200 || !json) {
    const detail = json && (json.userMessage || json.description || json.error);
    const err = new Error(`TIDAL ha risposto ${status}${detail ? ': ' + detail : ''}` +
      (status === 401 || status === 403 ? (auth ? ' — prova a rifare il login' : ' — accedi a TIDAL') : ''));
    err.status = status === 404 ? 404 : 502;
    throw err;
  }
  return json;
}

const img = (id, size = 320) => id ? `https://resources.tidal.com/images/${id.replace(/-/g, '/')}/${size}x${size}.jpg` : null;
const videoImg = (id) => id ? `https://resources.tidal.com/images/${id.replace(/-/g, '/')}/320x180.jpg` : null;
const artistNames = (o) => (o.artists && o.artists.length ? o.artists.map(a => a.name).join(', ') : (o.artist?.name || ''));

function qualityLabel(o) {
  const tags = o.mediaMetadata?.tags || [];
  if (tags.includes('HIRES_LOSSLESS') || o.audioQuality === 'HI_RES_LOSSLESS') return 'Hi-Res';
  if (tags.includes('DOLBY_ATMOS')) return 'Atmos';
  if (tags.includes('LOSSLESS') || o.audioQuality === 'LOSSLESS' || o.audioQuality === 'HI_RES') return 'Lossless';
  return '';
}

const mapArtist = (a) => ({
  id: a.id, name: a.name, picture: img(a.picture, 320), pictureLarge: img(a.picture, 750),
  url: `https://tidal.com/browse/artist/${a.id}`
});

const mapAlbum = (a) => ({
  id: a.id, title: a.title, artist: artistNames(a), artistId: a.artist?.id || a.artists?.[0]?.id || null,
  cover: img(a.cover, 320), coverLarge: img(a.cover, 640),
  year: a.releaseDate ? String(a.releaseDate).slice(0, 4) : '',
  releaseDate: a.releaseDate || '', tracks: a.numberOfTracks || 0, duration: a.duration || 0,
  type: a.type || 'ALBUM', explicit: !!a.explicit, quality: qualityLabel(a),
  url: `https://tidal.com/browse/album/${a.id}`
});

const mapTrack = (t) => ({
  id: t.id, title: t.version ? `${t.title} (${t.version})` : t.title, artist: artistNames(t),
  artistId: t.artist?.id || t.artists?.[0]?.id || null,
  album: t.album?.title || '', albumId: t.album?.id || null, cover: img(t.album?.cover, 320),
  duration: t.duration || 0, number: t.trackNumber || 0, volume: t.volumeNumber || 1,
  explicit: !!t.explicit, quality: qualityLabel(t),
  url: `https://tidal.com/browse/track/${t.id}`
});

const mapPlaylist = (p) => ({
  id: p.uuid, title: p.title, creator: p.creator?.name || (p.type === 'EDITORIAL' ? 'TIDAL' : ''),
  cover: img(p.squareImage, 320) || img(p.image, 320), coverLarge: img(p.squareImage, 640) || img(p.image, 640),
  tracks: p.numberOfTracks || 0, duration: p.duration || 0, description: p.description || '',
  url: `https://tidal.com/browse/playlist/${p.uuid}`
});

const mapVideo = (v) => ({
  id: v.id, title: v.title, artist: artistNames(v), cover: videoImg(v.imageId),
  duration: v.duration || 0, url: `https://tidal.com/browse/video/${v.id}`
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

// Ricerca
app.get('/api/search', wrap(async (req) => {
  const q = String(req.query.q || '').trim();
  if (!q) { const e = new Error('Parametro q richiesto'); e.status = 400; throw e; }
  const map = { track: 'TRACKS', album: 'ALBUMS', artist: 'ARTISTS', playlist: 'PLAYLISTS', video: 'VIDEOS' };
  const wanted = String(req.query.types || 'track,album,artist,playlist').split(',').filter(t => map[t]);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const data = await tidal('search', { query: q, limit, offset: 0, types: wanted.map(t => map[t]).join(',') });
  const items = (k) => (data[k] && data[k].items) || [];
  return {
    artists: items('artists').map(mapArtist),
    albums: items('albums').map(mapAlbum),
    tracks: items('tracks').map(mapTrack),
    playlists: items('playlists').map(mapPlaylist),
    videos: items('videos').map(mapVideo)
  };
}));

// Artista + discografia (album, EP/singoli, "appare in")
app.get('/api/artist/:id', wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);
  const list = (filter) => tidal(`artists/${id}/albums`, { limit: 100, offset: 0, ...(filter ? { filter } : {}) })
    .then(d => (d.items || []).map(mapAlbum)).catch(() => []);
  const [artist, albums, singles, compilations] = await Promise.all([
    tidal(`artists/${id}`), list(null), list('EPSANDSINGLES'), list('COMPILATIONS')
  ]);
  const byDate = (a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate));
  return {
    artist: mapArtist(artist),
    albums: albums.sort(byDate),
    singles: singles.sort(byDate),
    compilations: compilations.sort(byDate)
  };
}));

// Album + tracce
app.get('/api/album/:id', wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);
  const [album, items] = await Promise.all([
    tidal(`albums/${id}`),
    tidal(`albums/${id}/items`, { limit: 100, offset: 0 })
  ]);
  return {
    album: mapAlbum(album),
    tracks: (items.items || []).filter(i => i.type === 'track' || !i.type).map(i => mapTrack(i.item || i)),
    videos: (items.items || []).filter(i => i.type === 'video').map(i => mapVideo(i.item))
  };
}));

// Playlist + tracce
app.get('/api/playlist/:id', wrap(async (req) => {
  const id = encodeURIComponent(req.params.id);
  const [pl, items] = await Promise.all([
    tidal(`playlists/${id}`),
    tidal(`playlists/${id}/items`, { limit: 100, offset: 0 })
  ]);
  return {
    playlist: mapPlaylist(pl),
    tracks: (items.items || []).filter(i => i.type === 'track').map(i => mapTrack(i.item))
  };
}));

// Singola traccia (per i link incollati)
app.get('/api/track/:id', wrap(async (req) => mapTrack(await tidal(`tracks/${encodeURIComponent(req.params.id)}`))));

// Grandi artisti per genere (sfondo a vinili e vetrina in home)
const FEATURED = [
  ['Rock', ['The Beatles', 'Queen', 'Led Zeppelin', 'Pink Floyd', 'The Rolling Stones']],
  ['Pop', ['Michael Jackson', 'Madonna', 'Taylor Swift', 'ABBA']],
  ['Hip-Hop', ['Eminem', 'Kendrick Lamar', '2Pac', 'JAY-Z']],
  ['Jazz', ['Miles Davis', 'John Coltrane', 'Ella Fitzgerald', 'Louis Armstrong']],
  ['Soul & R&B', ['Aretha Franklin', 'Marvin Gaye', 'Stevie Wonder', 'Whitney Houston']],
  ['Elettronica', ['Daft Punk', 'Kraftwerk', 'The Chemical Brothers', 'Avicii']],
  ['Metal', ['Metallica', 'Black Sabbath', 'Iron Maiden', 'AC/DC']],
  ['Cantautori italiani', ['Lucio Battisti', 'Fabrizio De André', 'Vasco Rossi', 'Lucio Dalla']],
  ['Folk, Blues e Reggae', ['Bob Dylan', 'Johnny Cash', 'B.B. King', 'Bob Marley & The Wailers']]
];
const FEATURED_FILE = path.join(TIDDL_DIR, 'gui-featured.json');
let featuredCache = null, featuredLoading = null;

async function loadFeatured() {
  try {
    const c = JSON.parse(fs.readFileSync(FEATURED_FILE, 'utf8'));
    if (c && Date.now() - c.time < 7 * 24 * 3600 * 1000 && Array.isArray(c.genres)) return c.genres;
  } catch {}
  const find = async (name) => {
    try {
      const d = await tidal('search', { query: name, types: 'ARTISTS', limit: 5, offset: 0 });
      const items = d.artists?.items || [];
      const a = items.find(x => norm(x.name) === norm(name)) || items[0];
      return a && a.picture ? mapArtist(a) : null;
    } catch { return null; }
  };
  const genres = [];
  for (const [genre, names] of FEATURED) {
    const artists = (await Promise.all(names.map(find))).filter(Boolean);
    if (artists.length) genres.push({ genre, artists });
  }
  if (genres.length) {
    try { fs.mkdirSync(TIDDL_DIR, { recursive: true }); fs.writeFileSync(FEATURED_FILE, JSON.stringify({ time: Date.now(), genres })); } catch {}
  }
  return genres;
}

app.get('/api/featured', async (req, res) => {
  try {
    if (!featuredCache) {
      featuredLoading = featuredLoading || loadFeatured().finally(() => { featuredLoading = null; });
      const g = await featuredLoading;
      if (g.length) featuredCache = g;
      return res.json(g);
    }
    res.json(featuredCache);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Download ──────────────────────────────────────────────
const downloadHistory = [];
const activeDownloads = {};   // id -> { entry, proc }
let idCounter = 0;

function summary(entry) {
  const { logs, ...rest } = entry;
  return rest;
}

function detectType(url) {
  const m = url.match(/\/(album|track|playlist|video|artist|mix)\//);
  const map = { album: 'Album', track: 'Traccia', playlist: 'Playlist', video: 'Video', artist: 'Artista', mix: 'Mix' };
  return m ? map[m[1]] : 'unknown';
}

function isTidalUrl(str) {
  try {
    const u = new URL(str);
    return /^https?:$/.test(u.protocol) && (u.hostname === 'tidal.com' || u.hostname.endsWith('.tidal.com'));
  } catch { return false; }
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Pulisce i metadati passati dalla pagina (titolo, copertina, album della discografia)
function cleanMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const out = {
    title: str(m.title), subtitle: str(m.subtitle), cover: str(m.cover, 500),
    kind: str(m.kind, 20), totalTracks: Math.max(0, Math.min(parseInt(m.totalTracks, 10) || 0, 100000))
  };
  if (Array.isArray(m.albums)) {
    out.albums = m.albums.slice(0, 400).map(a => ({
      title: str(a.title), cover: str(a.cover, 500), tracks: Math.max(0, parseInt(a.tracks, 10) || 0), done: 0
    }));
  }
  return out;
}

// Salvataggio dello storico su disco (senza appesantirlo con tutti i log)
let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = downloadHistory.slice(-300).map(e => ({ ...e, logs: e.logs.slice(-200) }));
      fs.mkdirSync(TIDDL_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
    } catch {}
  }, 1000);
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(data)) return;
    for (const e of data) {
      if (e.status === 'running') { e.status = 'error'; e.error = 'Interrotto (il server è stato chiuso)'; }
      e.logs = Array.isArray(e.logs) ? e.logs : [];
      downloadHistory.push(e);
    }
  } catch {}
}
loadHistory();

app.get('/api/history', (req, res) => res.json(downloadHistory.slice().reverse().map(summary)));

app.delete('/api/history', (req, res) => {
  const running = downloadHistory.filter(d => d.status === 'running');
  downloadHistory.length = 0;
  downloadHistory.push(...running);
  saveHistory();
  res.json({ ok: true });
});

app.get('/api/active', (req, res) => res.json(Object.values(activeDownloads).map(a => summary(a.entry))));

app.get('/api/download/:id', (req, res) => {
  const entry = downloadHistory.find(d => d.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Download non trovato' });
  res.json(entry);
});

app.post('/api/download/:id/cancel', (req, res) => {
  const a = activeDownloads[req.params.id];
  if (!a) return res.status(404).json({ error: 'Download non in corso' });
  a.entry.cancelled = true;
  a.proc.kill('SIGTERM');
  setTimeout(() => { try { a.proc.kill('SIGKILL'); } catch {} }, 3000);
  res.json({ ok: true });
});

app.post('/api/download', (req, res) => {
  const body = req.body || {};
  const { quality, template, saveCovers, singles } = body;
  const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).map(u => String(u || '').trim()).filter(Boolean).slice(0, 300);
  let downloadPath = String(body.downloadPath || '').trim();

  if (!urls.length) return res.status(400).json({ error: 'URL richiesto' });
  const bad = urls.find(u => !isTidalUrl(u));
  if (bad) return res.status(400).json({ error: `URL non valido: ${bad}` });
  if (quality && quality !== 'auto' && !VALID_QUALITIES.includes(quality)) return res.status(400).json({ error: `Qualità non valida: ${quality}` });
  if (singles && !VALID_SINGLES.includes(singles)) return res.status(400).json({ error: `Opzione singoli non valida: ${singles}` });

  const auth = readAuth();
  if (!auth || !auth.token) return res.status(401).json({ error: 'Non sei collegato a TIDAL: clicca "Accedi a TIDAL" in alto a destra' });

  downloadPath = path.resolve(expandHome(downloadPath) || DEFAULT_DOWNLOAD_PATH);
  try { fs.mkdirSync(downloadPath, { recursive: true }); }
  catch (err) { return res.status(400).json({ error: `Impossibile creare la cartella ${downloadPath}: ${err.message}` }); }

  try { updateTiddlConfig(saveCovers !== false); }
  catch (err) { return res.status(500).json({ error: 'Impossibile aggiornare config.toml: ' + err.message }); }

  // Le opzioni vanno PRIMA del sottocomando "url"
  const args = ['download'];
  if (quality && quality !== 'auto') args.push('--track-quality', quality);
  args.push('--path', downloadPath);
  if (template && String(template).trim()) args.push('--output', String(template).trim());
  if (singles) args.push('--singles', singles);
  args.push('url', ...urls);

  const meta = cleanMeta(body.meta);
  const id = `${Date.now()}-${++idCounter}`;
  const entry = {
    id, url: urls[0], urls, type: urls.length > 1 ? 'Selezione' : detectType(urls[0]),
    quality: quality || 'auto', path: downloadPath, meta,
    status: 'running', progress: 0, itemsDone: 0, errorCount: 0, lastDir: null,
    logs: [], startTime: new Date().toISOString(), endTime: null, error: null
  };

  let proc;
  try { proc = spawnTiddl(args, { cwd: downloadPath }); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  activeDownloads[id] = { entry, proc };
  downloadHistory.push(entry);
  saveHistory();
  broadcast({ event: 'download_started', data: summary(entry) });

  const total = meta?.totalTracks || 0;

  const addLine = (line, isErr) => {
    entry.logs.push({ time: new Date().toISOString(), text: line, isErr: !!isErr });
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
    let albumIndex = -1;

    // Una riga per ogni elemento completato: "Downloaded <titolo> <qualità> <cartella>"
    if (/^(Downloaded|Exists)\b/.test(line)) {
      entry.itemsDone++;
      const dir = (line.match(/\s(\/.+)$/) || [])[1];
      if (dir) {
        entry.lastDir = dir;
        if (meta?.albums?.length) {
          const folder = norm(path.basename(dir));
          albumIndex = meta.albums.findIndex(a => { const t = norm(a.title); return t && (t === folder || folder.startsWith(t) || t.startsWith(folder)); });
          if (albumIndex >= 0) meta.albums[albumIndex].done++;
        }
      }
      entry.progress = total
        ? Math.min(99, Math.round(100 * entry.itemsDone / total))
        : Math.round(95 * (1 - Math.pow(0.85, entry.itemsDone)));
    } else if (/^(API Error|Error|Wrong \w+ Template)\b/.test(line) || /Traceback|Error:|Not logged in|tiddl auth login/.test(line)) {
      entry.errorCount++;
      isErr = true;
    } else if (entry.progress < 2) {
      entry.progress = 2;
    }

    broadcast({
      event: 'download_log', id, text: line, isErr: !!isErr,
      progress: entry.progress, itemsDone: entry.itemsDone, errorCount: entry.errorCount,
      albumIndex, albumDone: albumIndex >= 0 ? meta.albums[albumIndex].done : undefined
    });
  };

  const out = lineReader(l => addLine(l, false));
  const err = lineReader(l => addLine(l, true));
  proc.stdout.on('data', d => out.push(d));
  proc.stderr.on('data', d => err.push(d));

  let finished = false;
  const finish = (status, error) => {
    if (finished) return;
    finished = true;
    out.flush(); err.flush();
    entry.status = status;
    entry.error = error;
    entry.endTime = new Date().toISOString();
    if (status === 'done') entry.progress = 100;
    delete activeDownloads[id];
    saveHistory();
    broadcast({ event: 'download_done', id, status, error, data: summary(entry) });
  };

  proc.on('close', (code) => {
    const lastErr = [...entry.logs].reverse().find(l => l.isErr);
    if (entry.cancelled) finish('cancelled', 'Annullato');
    else if (code === 0 && entry.errorCount > 0 && entry.itemsDone === 0) finish('error', lastErr ? lastErr.text : 'Nessun elemento scaricato');
    else if (code === 0) finish('done', entry.errorCount ? `${entry.errorCount} errori durante il download (vedi log)` : null);
    else finish('error', `Processo terminato con codice ${code}${lastErr ? ': ' + lastErr.text : ''}`);
  });
  proc.on('error', (e) => finish('error', e.message));

  res.json({ id, message: 'Download avviato' });
});

// ── Autenticazione ────────────────────────────────────────
let noBrowserCache = null;
function tiddlSupportsNoBrowser() {
  if (noBrowserCache !== null) return noBrowserCache;
  try {
    const out = spawnSync(findTiddl(), ['auth', 'login', '--help'], { env: buildEnv(), encoding: 'utf8', timeout: 15000 });
    noBrowserCache = /--no-browser/.test((out.stdout || '') + (out.stderr || ''));
  } catch { noBrowserCache = false; }
  return noBrowserCache;
}

let authProc = null;

app.post('/api/auth', (req, res) => {
  if (authProc) return res.status(409).json({ error: 'Autenticazione già in corso' });
  let proc;
  try { proc = spawnTiddl(['auth', 'login', ...(tiddlSupportsNoBrowser() ? ['--no-browser'] : [])]); }
  catch (err) { return res.status(500).json({ error: err.message }); }
  authProc = proc;
  let authUrl = null;

  const onLine = (line) => {
    const m = line.match(/https?:\/\/[^\s'"]+/);
    if (m && !authUrl) { authUrl = m[0]; broadcast({ event: 'auth_url', url: authUrl }); }
    broadcast({ event: 'auth_log', text: line });
  };
  const out = lineReader(onLine), err = lineReader(onLine);
  proc.stdout.on('data', d => out.push(d));
  proc.stderr.on('data', d => err.push(d));
  const timeout = setTimeout(() => proc.kill(), 6 * 60 * 1000);

  const done = (code) => {
    if (authProc !== proc) return;
    authProc = null;
    clearTimeout(timeout);
    out.flush(); err.flush();
    const auth = readAuth();
    broadcast({ event: 'auth_done', code, success: code === 0 && !!(auth && auth.token) });
  };
  proc.on('close', done);
  proc.on('error', (e) => { broadcast({ event: 'auth_log', text: e.message }); done(-1); });
  res.json({ message: 'Autenticazione avviata' });
});

app.post('/api/logout', (req, res) => {
  let proc;
  try { proc = spawnTiddl(['auth', 'logout', '--force']); }
  catch (err) { return res.status(500).json({ error: err.message }); }
  let replied = false;
  const reply = (s, b) => { if (!replied) { replied = true; res.status(s).json(b); } };
  proc.on('close', () => reply(200, { ok: true, authenticated: !!readAuth()?.token }));
  proc.on('error', (e) => reply(500, { error: e.message }));
});

app.get('/api/auth-status', (req, res) => {
  const auth = readAuth();
  res.json({
    authenticated: !!(auth && auth.token), userId: auth?.user_id || null,
    country: auth?.country_code || null, tiddlFound: !!findTiddl()
  });
});

// ── Cartelle ──────────────────────────────────────────────
// Finestra "Scegli cartella" di macOS
app.get('/api/browse', (req, res) => {
  if (process.platform !== 'darwin') return res.json({ path: null, unsupported: true });
  const start = path.resolve(expandHome(String(req.query.start || '')) || DEFAULT_DOWNLOAD_PATH);
  let choose = 'set f to choose folder with prompt "Scegli dove salvare i download"';
  try {
    if (fs.statSync(start).isDirectory()) choose += ` default location (POSIX file "${start.replace(/["\\]/g, '\\$&')}")`;
  } catch {}
  execFile('osascript', ['-e', choose, '-e', 'POSIX path of f'], (err, stdout) => {
    if (err) return res.json({ path: null }); // annullato
    res.json({ path: stdout.trim().replace(/\/$/, '') || '/' });
  });
});

// Apre una cartella nel Finder
app.post('/api/open-folder', (req, res) => {
  const p = path.resolve(expandHome(String(req.body?.path || '')) || DEFAULT_DOWNLOAD_PATH);
  try { if (!fs.statSync(p).isDirectory()) throw new Error(); }
  catch { return res.status(404).json({ error: 'La cartella non esiste (ancora)' }); }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [p], () => {});
  res.json({ ok: true });
});

app.get('/api/defaults', (req, res) => {
  res.json({ downloadPath: DEFAULT_DOWNLOAD_PATH, platform: process.platform, home: HOME });
});

wss.on('connection', (ws) => ws.send(JSON.stringify({ event: 'connected' })));

const PORT = parseInt(process.env.PORT, 10) || 7432;
const HOST = process.env.HOST || '127.0.0.1';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ La porta ${PORT} è già in uso. Chiudi l'altra istanza o avvia con PORT=7433 node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n🎵 tiddl GUI avviato su http://localhost:${PORT}\n`);
  const bin = findTiddl();
  console.log(bin ? `   tiddl: ${bin}` : '   ⚠️  tiddl non trovato: installalo con "pipx install tiddl" o imposta TIDDL_BIN');
});
