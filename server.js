const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Percorsi e ambiente ───────────────────────────────────
const HOME = os.homedir();
const TIDDL_DIR = process.env.TIDDL_PATH || path.join(HOME, '.tiddl');
const AUTH_FILE = path.join(TIDDL_DIR, 'auth.json');
const CONFIG_FILE = path.join(TIDDL_DIR, 'config.toml');
const DEFAULT_DOWNLOAD_PATH = path.join(HOME, 'Music', 'tiddl');

const EXTRA_PATHS = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
];

const VALID_QUALITIES = ['low', 'normal', 'high', 'max'];
const MAX_LOG_LINES = 3000;

function buildEnv() {
  return {
    ...process.env,
    PATH: [...EXTRA_PATHS, process.env.PATH || ''].join(path.delimiter),
    // Senza questo Python bufferizza l'output quando non è su un terminale:
    // i log (e il link di login) arriverebbero solo a processo terminato.
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Output di rich pulito e su righe lunghe (niente link spezzati)
    NO_COLOR: '1',
    TERM: 'dumb',
    COLUMNS: '250'
  };
}

// Trova l'eseguibile tiddl: variabile TIDDL_BIN, poi i percorsi noti, poi il PATH
function findTiddl() {
  if (process.env.TIDDL_BIN) return process.env.TIDDL_BIN;
  const dirs = [...EXTRA_PATHS, ...(process.env.PATH || '').split(path.delimiter)];
  const names = process.platform === 'win32' ? ['tiddl.exe', 'tiddl.cmd', 'tiddl'] : ['tiddl'];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

function spawnTiddl(args, options = {}) {
  const bin = findTiddl();
  if (!bin) {
    const err = new Error('tiddl non trovato. Installalo (es. "pipx install tiddl") oppure imposta la variabile TIDDL_BIN.');
    err.code = 'TIDDL_NOT_FOUND';
    throw err;
  }
  return spawn(bin, args, { env: buildEnv(), ...options });
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// Toglie codici ANSI e caratteri di controllo dall'output del CLI
function cleanLine(line) {
  return line
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')       // link OSC 8
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')         // colori / cursore
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd();
}

// Spezza uno stream in righe complete, gestendo chunk a metà riga e \r
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

// Broadcast a tutti i client WebSocket
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ── Auth data ─────────────────────────────────────────────
function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
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

// Token valido per le chiamate API (rinnovato tramite tiddl se in scadenza)
async function getAuthToken() {
  let auth = readAuth();
  if (!auth || !auth.token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (auth.expires_at && auth.expires_at - 300 < now) {
    await runTiddlQuiet(['auth', 'refresh']);
    auth = readAuth();
  }
  return auth && auth.token ? auth : null;
}

// ── Config tiddl ──────────────────────────────────────────
// Aggiorna solo le sezioni gestite dalla GUI, lasciando intatto il resto
// del config.toml dell'utente (percorsi, template, qualità di default...).
function updateTiddlConfig(saveCovers) {
  const v = saveCovers ? 'true' : 'false';
  const managed = {
    'metadata': `enable = true\ncover = ${v}\nlyrics = ${v}`,
    'cover': `save = ${v}\nsize = 1280\nallowed = ["album", "track", "playlist"]`,
    'cover.templates': `album = "{album.artist}/{album.title}/cover"\ntrack = "{album.artist}/{album.title}/cover"\nplaylist = "{playlist.title}/cover"`
  };

  let existing = '';
  try { existing = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch {}

  // Divide il file in [sezioni]
  const sections = [];
  let current = { name: null, lines: [] };
  for (const line of existing.split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\[\]]+)\]\s*(#.*)?$/);
    if (m) {
      sections.push(current);
      current = { name: m[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const kept = sections.filter(s => !(s.name in managed));
  let out = kept.map(s => s.lines.join('\n').replace(/\s+$/, '')).filter(Boolean).join('\n\n');
  for (const [name, body] of Object.entries(managed)) {
    out += `${out ? '\n\n' : ''}[${name}]\n${body}`;
  }

  fs.mkdirSync(TIDDL_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, out + '\n');
}

// ── TIDAL Search API ──────────────────────────────────────
function tidalFetch(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', ...headers },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout della richiesta a TIDAL')));
    req.on('error', reject);
  });
}

function tidalImage(id, size = 320) {
  return id ? `https://resources.tidal.com/images/${id.replace(/-/g, '/')}/${size}x${size}.jpg` : null;
}

app.get('/api/search', async (req, res) => {
  const { q, type } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Parametro q richiesto' });

  const allowedTypes = ['artists', 'albums', 'tracks'];
  const searchType = allowedTypes.includes(type) ? type : allowedTypes.join(',');

  try {
    // Con l'account collegato usa il token dell'utente (stesso metodo di tiddl);
    // altrimenti ripiega sul token pubblico del web player.
    const auth = await getAuthToken();
    const country = (auth && auth.country_code) || 'IT';
    const headers = auth
      ? { 'Authorization': `Bearer ${auth.token}` }
      : { 'x-tidal-token': 'CzET4vdadNUFQ5JU' };

    const url = `https://api.tidal.com/v1/search?query=${encodeURIComponent(q.trim())}` +
      `&limit=12&offset=0&types=${searchType}&countryCode=${country}`;
    const { status, json: data } = await tidalFetch(url, headers);

    if (status !== 200 || !data) {
      const detail = data && (data.userMessage || data.description || data.error);
      const hint = status === 401 || status === 403
        ? (auth ? ' — prova a rifare il login a TIDAL' : ' — accedi a TIDAL per usare la ricerca')
        : '';
      return res.status(502).json({ error: `TIDAL ha risposto ${status}${detail ? ': ' + detail : ''}${hint}` });
    }

    const results = { artists: [], albums: [], tracks: [] };
    const names = list => (list || []).map(x => x.name).join(', ');

    if (data.artists && data.artists.items) {
      results.artists = data.artists.items.map(a => ({
        id: a.id,
        name: a.name,
        picture: tidalImage(a.picture),
        url: `https://tidal.com/browse/artist/${a.id}`
      }));
    }

    if (data.albums && data.albums.items) {
      results.albums = data.albums.items.map(a => ({
        id: a.id,
        title: a.title,
        artist: a.artists ? names(a.artists) : (a.artist?.name || ''),
        cover: tidalImage(a.cover),
        year: a.releaseDate ? a.releaseDate.substring(0, 4) : '',
        tracks: a.numberOfTracks || 0,
        url: `https://tidal.com/browse/album/${a.id}`
      }));
    }

    if (data.tracks && data.tracks.items) {
      results.tracks = data.tracks.items.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artists ? names(t.artists) : (t.artist?.name || ''),
        album: t.album?.title || '',
        cover: tidalImage(t.album?.cover),
        duration: t.duration || 0,
        url: `https://tidal.com/browse/track/${t.id}`
      }));
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Errore nella ricerca: ' + err.message });
  }
});

// ── Download ──────────────────────────────────────────────
const downloadHistory = [];
const activeDownloads = {};

// Versione "leggera" senza i log, per le liste
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
  } catch {
    return false;
  }
}

app.get('/api/history', (req, res) => {
  res.json(downloadHistory.slice().reverse().map(summary));
});

app.delete('/api/history', (req, res) => {
  // tiene solo quelli ancora in corso
  const running = downloadHistory.filter(d => d.status === 'running');
  downloadHistory.length = 0;
  downloadHistory.push(...running);
  res.json({ ok: true });
});

app.get('/api/active', (req, res) => {
  res.json(Object.values(activeDownloads).map(summary));
});

app.get('/api/download/:id', (req, res) => {
  const entry = downloadHistory.find(d => d.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Download non trovato' });
  res.json(entry);
});

let idCounter = 0;

app.post('/api/download', (req, res) => {
  const { quality, template, saveCovers } = req.body || {};
  const url = (req.body?.url || '').trim();
  let downloadPath = (req.body?.downloadPath || '').trim();

  if (!url) return res.status(400).json({ error: 'URL richiesto' });
  if (!isTidalUrl(url)) return res.status(400).json({ error: 'URL non valido: deve essere un link TIDAL' });
  if (quality && quality !== 'auto' && !VALID_QUALITIES.includes(quality)) {
    return res.status(400).json({ error: `Qualità non valida: ${quality}` });
  }

  // Senza login tiddl esce con "Not logged in." e codice 0: meglio fermarsi prima
  const auth = readAuth();
  if (!auth || !auth.token) {
    return res.status(401).json({ error: 'Non sei collegato a TIDAL: clicca "Accedi a TIDAL" in alto a destra' });
  }

  // Cartella di destinazione: espande ~ e la crea se non esiste
  downloadPath = path.resolve(expandHome(downloadPath) || DEFAULT_DOWNLOAD_PATH);
  try {
    fs.mkdirSync(downloadPath, { recursive: true });
  } catch (err) {
    return res.status(400).json({ error: `Impossibile creare la cartella ${downloadPath}: ${err.message}` });
  }

  try {
    updateTiddlConfig(saveCovers !== false);
  } catch (err) {
    return res.status(500).json({ error: 'Impossibile aggiornare config.toml: ' + err.message });
  }

  // Le opzioni vanno PRIMA del sottocomando "url"
  const args = ['download'];
  if (quality && quality !== 'auto') args.push('--track-quality', quality);
  args.push('--path', downloadPath);
  if (template && template.trim()) args.push('--output', template.trim());
  args.push('url', url);

  const id = `${Date.now()}-${++idCounter}`;
  const entry = {
    id,
    url,
    type: detectType(url),
    quality: quality || 'auto',
    path: downloadPath,
    status: 'running',
    progress: 0,
    itemsDone: 0,
    errorCount: 0,
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  let proc;
  try {
    proc = spawnTiddl(args, { cwd: downloadPath });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  activeDownloads[id] = entry;
  downloadHistory.push(entry);
  broadcast({ event: 'download_started', data: summary(entry) });

  const addLine = (line, isErr) => {
    entry.logs.push({ time: new Date().toISOString(), text: line, isErr: !!isErr });
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);

    // tiddl stampa una riga per ogni elemento completato ("Downloaded ..." / "Exists ...")
    if (/^(Downloaded|Exists)\b/.test(line)) {
      entry.itemsDone++;
      entry.progress = Math.round(95 * (1 - Math.pow(0.85, entry.itemsDone)));
    } else if (/^(API Error|Error|Wrong \w+ Template)\b/.test(line) || /Traceback|Error:|Not logged in|tiddl auth login/.test(line)) {
      entry.errorCount++;
      isErr = true;
    } else if (entry.progress < 5) {
      entry.progress = 5;
    }

    broadcast({ event: 'download_log', id, text: line, isErr: !!isErr, progress: entry.progress, itemsDone: entry.itemsDone });
  };

  const out = lineReader(l => addLine(l, false));
  const err = lineReader(l => addLine(l, true));
  proc.stdout.on('data', d => out.push(d));
  proc.stderr.on('data', d => err.push(d));

  let finished = false;
  const finish = (status, error) => {
    if (finished) return;
    finished = true;
    out.flush();
    err.flush();
    entry.status = status;
    entry.error = error;
    entry.endTime = new Date().toISOString();
    if (status === 'done') entry.progress = 100;
    delete activeDownloads[id];
    broadcast({
      event: 'download_done', id, status, error,
      itemsDone: entry.itemsDone, errorCount: entry.errorCount
    });
  };

  proc.on('close', (code) => {
    if (code === 0 && entry.errorCount > 0 && entry.itemsDone === 0) {
      // nessun brano scaricato e solo errori: è un fallimento
      const lastErr = [...entry.logs].reverse().find(l => l.isErr);
      finish('error', lastErr ? lastErr.text : 'Nessun elemento scaricato');
    } else if (code === 0) {
      // tiddl esce con 0 anche se alcuni brani falliscono: lo segnaliamo
      finish('done', entry.errorCount ? `${entry.errorCount} errori durante il download (vedi log)` : null);
    } else {
      const lastErr = [...entry.logs].reverse().find(l => l.isErr);
      finish('error', `Processo terminato con codice ${code}${lastErr ? ': ' + lastErr.text : ''}`);
    }
  });

  proc.on('error', (e) => finish('error', e.message));

  res.json({ id, message: 'Download avviato' });
});

// ── Autenticazione ────────────────────────────────────────
let authProc = null;

app.post('/api/auth', (req, res) => {
  if (authProc) {
    return res.status(409).json({ error: 'Autenticazione già in corso' });
  }

  let proc;
  try {
    // --no-browser: il link lo apre la pagina web, non il server
    proc = spawnTiddl(['auth', 'login', '--no-browser']);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  authProc = proc;
  let authUrl = null;

  const onLine = (line) => {
    const m = line.match(/https?:\/\/[^\s'"]+/);
    if (m && !authUrl) {
      authUrl = m[0];
      broadcast({ event: 'auth_url', url: authUrl });
    }
    broadcast({ event: 'auth_log', text: line });
  };
  const out = lineReader(onLine);
  const err = lineReader(onLine);
  proc.stdout.on('data', d => out.push(d));
  proc.stderr.on('data', d => err.push(d));

  // Dopo 6 minuti senza conferma il codice TIDAL scade comunque
  const timeout = setTimeout(() => proc.kill(), 6 * 60 * 1000);

  const done = (code) => {
    if (authProc !== proc) return;
    authProc = null;
    clearTimeout(timeout);
    out.flush();
    err.flush();
    const auth = readAuth();
    const success = code === 0 && !!(auth && auth.token);
    broadcast({ event: 'auth_done', code, success });
  };
  proc.on('close', done);
  proc.on('error', (e) => { broadcast({ event: 'auth_log', text: e.message }); done(-1); });

  res.json({ message: 'Autenticazione avviata' });
});

app.post('/api/logout', (req, res) => {
  let proc;
  try {
    proc = spawnTiddl(['auth', 'logout', '--force']);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  let replied = false;
  const reply = (status, body) => { if (!replied) { replied = true; res.status(status).json(body); } };
  proc.on('close', () => reply(200, { ok: true, authenticated: !!readAuth()?.token }));
  proc.on('error', (e) => reply(500, { error: e.message }));
});

app.get('/api/auth-status', (req, res) => {
  const auth = readAuth();
  res.json({
    authenticated: !!(auth && auth.token),
    userId: auth?.user_id || null,
    country: auth?.country_code || null,
    tiddlFound: !!findTiddl()
  });
});

// ── Sfoglia cartella (solo macOS) ─────────────────────────
app.get('/api/browse', (req, res) => {
  if (process.platform !== 'darwin') {
    return res.json({ path: null, unsupported: true });
  }
  exec('osascript -e \'POSIX path of (choose folder with prompt "Seleziona la cartella di download:")\'', (err, stdout) => {
    if (err) return res.json({ path: null }); // annullato dall'utente
    res.json({ path: stdout.trim() });
  });
});

app.get('/api/defaults', (req, res) => {
  res.json({ downloadPath: DEFAULT_DOWNLOAD_PATH });
});

// WebSocket
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'connected', message: 'Connesso al server tiddl GUI' }));
});

const PORT = parseInt(process.env.PORT, 10) || 7432;
// Solo in locale: il server può avviare processi e scrivere file
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
  if (bin) console.log(`   tiddl: ${bin}`);
  else console.log('   ⚠️  tiddl non trovato: installalo con "pipx install tiddl" o imposta TIDDL_BIN');
});
