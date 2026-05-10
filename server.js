const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
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

// Trova il percorso di tiddl
const TIDDL_PATH = path.join(os.homedir(), '.local', 'bin', 'tiddl');

// Storico download in memoria
const downloadHistory = [];
let activeDownloads = {};

// Broadcast a tutti i client WebSocket
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// ── TIDAL Search API ──────────────────────────────────────
function tidalFetch(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-tidal-token': 'CzET4vdadNUFQ5JU',
        'User-Agent': 'Mozilla/5.0'
      }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Parse error' }); }
      });
    }).on('error', reject);
  });
}

app.get('/api/search', async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'Parametro q richiesto' });

  const searchType = type || 'albums,artists,tracks';
  const limit = 12;

  try {
    const url = `https://api.tidal.com/v1/search?query=${encodeURIComponent(q)}&limit=${limit}&offset=0&types=${searchType}&countryCode=IT`;
    const data = await tidalFetch(url);
    
    const results = { artists: [], albums: [], tracks: [] };

    if (data.artists && data.artists.items) {
      results.artists = data.artists.items.map(a => ({
        id: a.id,
        name: a.name,
        picture: a.picture ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg` : null,
        url: `https://tidal.com/artist/${a.id}`
      }));
    }

    if (data.albums && data.albums.items) {
      results.albums = data.albums.items.map(a => ({
        id: a.id,
        title: a.title,
        artist: a.artists ? a.artists.map(ar => ar.name).join(', ') : (a.artist?.name || ''),
        cover: a.cover ? `https://resources.tidal.com/images/${a.cover.replace(/-/g, '/')}/320x320.jpg` : null,
        year: a.releaseDate ? a.releaseDate.substring(0, 4) : '',
        tracks: a.numberOfTracks || 0,
        url: `https://tidal.com/album/${a.id}`
      }));
    }

    if (data.tracks && data.tracks.items) {
      results.tracks = data.tracks.items.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artists ? t.artists.map(ar => ar.name).join(', ') : (t.artist?.name || ''),
        album: t.album?.title || '',
        cover: t.album?.cover ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/320x320.jpg` : null,
        duration: t.duration || 0,
        url: `https://tidal.com/track/${t.id}`
      }));
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Errore nella ricerca: ' + err.message });
  }
});

// ── API: ottieni storico ──
app.get('/api/history', (req, res) => {
  res.json(downloadHistory.slice().reverse());
});

// ── API: ottieni download attivi ──
app.get('/api/active', (req, res) => {
  res.json(Object.values(activeDownloads));
});

// ── API: avvia un download ──
app.post('/api/download', (req, res) => {
  const { url, quality, downloadPath, template, saveCovers } = req.body;

  if (!url) return res.status(400).json({ error: 'URL richiesto' });

  if (!url.includes('tidal.com')) {
    return res.status(400).json({ error: 'URL non valido: deve essere un link TIDAL' });
  }

  // Aggiorna config in base allo switch
  const configContent = `[metadata]
enable = true
cover = ${saveCovers ? 'true' : 'false'}
lyrics = ${saveCovers ? 'true' : 'false'}
save_lyrics = ${saveCovers ? 'true' : 'false'}

[cover]
save = ${saveCovers ? 'true' : 'false'}
size = 1280
allowed = ["album", "track", "playlist"]

[cover.templates]
album = "{album.artist}/{album.title}/cover"
track = "{album.artist}/{album.title}/cover"
playlist = "{playlist.title}/cover"
`;
  const tiddlDir = path.join(os.homedir(), '.tiddl');
  if (!fs.existsSync(tiddlDir)) fs.mkdirSync(tiddlDir, { recursive: true });
  fs.writeFileSync(path.join(tiddlDir, 'config.toml'), configContent);

  const id = Date.now().toString();
  const args = ['download'];

  if (quality && quality !== 'auto') args.push('--track-quality', quality);
  if (downloadPath) args.push('--path', downloadPath);
  if (template) args.push('--template', template);

  args.push('url', url);

  let type = 'unknown';
  if (url.includes('/album/')) type = 'Album';
  else if (url.includes('/track/')) type = 'Traccia';
  else if (url.includes('/playlist/')) type = 'Playlist';
  else if (url.includes('/video/')) type = 'Video';
  else if (url.includes('/artist/')) type = 'Artista';

  const downloadEntry = {
    id,
    url,
    type,
    quality: quality || 'auto',
    status: 'running',
    progress: 0,
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  activeDownloads[id] = downloadEntry;
  downloadHistory.push(downloadEntry);

  broadcast({ event: 'download_started', data: downloadEntry });

  const env = {
    ...process.env,
    PATH: `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
  };

  const proc = spawn(TIDDL_PATH, args, {
    env,
    cwd: downloadPath || os.homedir()
  });

  proc.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (!text) return;
    const lines = text.split('\n').filter(l => l.trim());
    lines.forEach(line => {
      downloadEntry.logs.push({ time: new Date().toISOString(), text: line });

      if (line.includes('Downloading') || line.includes('downloading')) {
        downloadEntry.progress = Math.min(downloadEntry.progress + 10, 90);
      }

      broadcast({ event: 'download_log', id, text: line, progress: downloadEntry.progress });
    });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (!text) return;
    const lines = text.split('\n').filter(l => l.trim());
    lines.forEach(line => {
      downloadEntry.logs.push({ time: new Date().toISOString(), text: line, isErr: true });
      broadcast({ event: 'download_log', id, text: line, isErr: true, progress: downloadEntry.progress });
    });
  });

  proc.on('close', (code) => {
    downloadEntry.status = code === 0 ? 'done' : 'error';
    downloadEntry.progress = code === 0 ? 100 : downloadEntry.progress;
    downloadEntry.endTime = new Date().toISOString();
    if (code !== 0) downloadEntry.error = `Processo terminato con codice ${code}`;
    delete activeDownloads[id];
    broadcast({ event: 'download_done', id, status: downloadEntry.status, error: downloadEntry.error });
  });

  proc.on('error', (err) => {
    downloadEntry.status = 'error';
    downloadEntry.error = err.message;
    downloadEntry.endTime = new Date().toISOString();
    delete activeDownloads[id];
    broadcast({ event: 'download_done', id, status: 'error', error: err.message });
  });

  res.json({ id, message: 'Download avviato' });
});

// ── API: avvia autenticazione ──
app.post('/api/auth', (req, res) => {
  const env = {
    ...process.env,
    PATH: `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
  };

  const proc = spawn(TIDDL_PATH, ['auth', 'login'], { env });
  let output = '';
  let authUrl = null;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    const urlMatch = text.match(/https?:\/\/[^\s']+/);
    if (urlMatch && !authUrl) {
      authUrl = urlMatch[0];
      broadcast({ event: 'auth_url', url: authUrl });
    }
    broadcast({ event: 'auth_log', text: text.trim() });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    output += text;
    const urlMatch = text.match(/https?:\/\/[^\s']+/);
    if (urlMatch && !authUrl) {
      authUrl = urlMatch[0];
      broadcast({ event: 'auth_url', url: authUrl });
    }
    broadcast({ event: 'auth_log', text: text.trim() });
  });

  proc.on('close', (code) => {
    broadcast({ event: 'auth_done', code, success: code === 0 });
  });

  res.json({ message: 'Autenticazione avviata' });
});

// ── API: sfoglia cartella (solo Mac) ──
app.get('/api/browse', (req, res) => {
  const { exec } = require('child_process');
  exec('osascript -e \'POSIX path of (choose folder with prompt "Seleziona la cartella di download:")\'', (err, stdout) => {
    if (err) {
      return res.json({ path: null });
    }
    res.json({ path: stdout.trim() });
  });
});

// ── API: verifica stato autenticazione ──
app.get('/api/auth-status', (req, res) => {
  const authFile = path.join(os.homedir(), '.tiddl', 'auth.json');
  try {
    if (fs.existsSync(authFile)) {
      const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      res.json({ authenticated: true, userId: data.user_id || null, email: data.email || null });
    } else {
      res.json({ authenticated: false });
    }
  } catch {
    res.json({ authenticated: false });
  }
});

// WebSocket
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'connected', message: 'Connesso al server tiddl GUI' }));
});

const PORT = 7432;
server.listen(PORT, () => {
  console.log(`\n🎵 tiddl GUI avviato su http://localhost:${PORT}\n`);
});
