// ============================================================
// audio-extractor - local video to audio converter (web UI)
// Release version. All messages in English by design:
// avoids CMD/codepage mojibake on non-Chinese Windows systems.
//
// FFmpeg lookup chain : ./ffmpeg.exe -> %FFMPEG_PATH% -> PATH
// Default bind        : 127.0.0.1 (set AUDIO_EXTRACTOR_LAN=1 for LAN)
// Port                : starts at AUDIO_EXTRACTOR_PORT or 8912,
//                       auto-increments if busy.
// ============================================================
'use strict';

const express = require('express');
const multer = require('multer');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const app = express();
const START_PORT = parseInt(process.env.AUDIO_EXTRACTOR_PORT || '8912', 10);
const MAX_PORT_TRIES = 10;
const MAX_CONCURRENT_JOBS = 2;

const LAN_MODE = process.env.AUDIO_EXTRACTOR_LAN === '1';
const HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';
if (LAN_MODE) {
  console.log('[!] LAN mode ON: the service is reachable from other devices on your network.');
}

// ---------- ffmpeg lookup ----------
function resolveFfmpeg() {
  const candidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    process.env.FFMPEG_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return 'ffmpeg'; // rely on system PATH
}
const FFMPEG = resolveFfmpeg();

function verifyFfmpeg(cb) {
  const ff = spawn(FFMPEG, ['-version']);
  let out = '';
  ff.stdout.on('data', d => { out += d.toString(); });
  ff.on('error', () => cb(new Error(
    'ffmpeg.exe not found.\n' +
    'Looked in: ' + __dirname + ', %FFMPEG_PATH%, and system PATH.\n' +
    'Keep ffmpeg.exe next to start.bat and try again.')));
  ff.on('close', code => {
    if (code === 0 && /ffmpeg version/i.test(out)) cb(null, out.split('\n')[0].trim());
    else cb(new Error('ffmpeg found but not runnable (exit ' + code + ').'));
  });
}

// ---------- dirs ----------
const ROOT = __dirname;
const TMP_UPLOADS = path.join(ROOT, 'tmp_uploads');
const CHUNK_DIR = path.join(ROOT, 'tmp_chunks');
for (const d of [TMP_UPLOADS, CHUNK_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
// clean leftovers from a previous run at startup
for (const d of [TMP_UPLOADS, CHUNK_DIR]) {
  try {
    for (const f of fs.readdirSync(d)) {
      fs.rmSync(path.join(d, f), { recursive: true, force: true });
    }
  } catch (_) { /* best effort */ }
}

const upload = multer({
  dest: TMP_UPLOADS,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4 GB per file
});

// ---------- format table ----------
const FORMAT_MAP = {
  m4a:  { ext: '.m4a',  args: ['-c:a', 'copy'] },
  mp3:  { ext: '.mp3',  args: ['-acodec', 'libmp3lame', '-q:a', '2'] },
  wav:  { ext: '.wav',  args: ['-acodec', 'pcm_s16le'] },
  flac: { ext: '.flac', args: ['-acodec', 'flac'] },
  opus: { ext: '.opus', args: ['-acodec', 'libopus', '-b:a', '128k'] }
};

function withExt(inputPath, ext) {
  // ext already includes its leading dot (.m4a / .mp3 / ...)
  const base = inputPath.replace(/\.[^.]+$/, '').replace(/\.+$/, '');
  return base + ext;
}

function timeToSec(s) {
  const m = s.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

let activeJobs = 0;

function extract(inputPath, format) {
  return new Promise((resolve, reject) => {
    const fmt = FORMAT_MAP[format];
    if (!fmt) { reject(new Error('Unsupported format: ' + format)); return; }

    // m4a keeps the original AAC stream when possible (container-level copy)
    const streamCopy = (format === 'm4a');
    const outPath = withExt(inputPath, fmt.ext);
    const args = [
      '-i', inputPath,
      '-vn',
      ...(streamCopy ? ['-c:a', 'copy'] : fmt.args),
      '-y',
      outPath
    ];

    activeJobs++;
    const ff = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    let duration = 0;

    ff.stderr.on('data', d => {
      stderr += d.toString();
      if (!duration) {
        const dm = stderr.match(/Duration:\s*([\d:.]+)/);
        if (dm) duration = timeToSec(dm[1]);
      }
    });

    ff.on('error', err => {
      activeJobs--;
      fs.unlink(inputPath, () => {});
      reject(new Error('Failed to launch ffmpeg: ' + err.message));
    });

    ff.on('close', code => {
      activeJobs--;
      fs.unlink(inputPath, () => {});
      if (code !== 0) {
        console.error('[ffmpeg] ' + stderr.slice(-400));
        reject(new Error('Transcode failed: file may be corrupted or use an unsupported codec.'));
        return;
      }
      if (!fs.existsSync(outPath)) {
        reject(new Error('Output file was not produced.'));
        return;
      }
      resolve({ path: outPath, size: fs.statSync(outPath).size });
    });
  });
}

// ---------- helpers ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// ---------- API ----------
app.post('/api/extract', upload.single('video'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No video file received.' }); return; }
  if (!FORMAT_MAP[req.body.format || 'm4a']) {
    res.status(400).json({ error: 'Unsupported format.' }); return;
  }
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    fs.unlink(req.file.path, () => {});
    res.status(429).json({ error: 'Server busy (' + MAX_CONCURRENT_JOBS + ' jobs running). Try again shortly.' });
    return;
  }
  try {
    const result = await extract(req.file.path, req.body.format || 'm4a');
    const base = path.basename(req.file.originalname, path.extname(req.file.originalname))
      .replace(/[\\/:*?"<>|]/g, '_') || 'audio';
    res.json({
      ok: true,
      progress: 100,
      downloadName: base + FORMAT_MAP[req.body.format || 'm4a'].ext,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/download', (req, res) => {
  let raw = '';
  try { raw = decodeURIComponent(req.query.file || ''); } catch (_) { res.status(400).send('Bad request'); return; }
  const safe = path.basename(raw);
  if (!safe || safe.startsWith('.')) { res.status(400).send('Bad request'); return; }
  const file = path.join(TMP_UPLOADS, safe);
  if (!file.startsWith(TMP_UPLOADS + path.sep)) { res.status(400).send('Bad request'); return; }
  if (!fs.existsSync(file)) { res.status(404).send('Not found'); return; }
  res.download(file);
});

// chunked upload (used for files > 50 MB from the browser)
const uploadSessions = new Map();

app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename, fileSize } = req.body;
  if (!uploadId || !req.file) { res.status(400).json({ error: 'Missing parameters.' }); return; }
  if (!isLoopback(req) && !LAN_MODE) { res.status(403).json({ error: 'Forbidden.' }); return; }

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  fs.renameSync(req.file.path, path.join(sessionDir, 'chunk_' + chunkIndex));

  if (!uploadSessions.has(uploadId)) {
    uploadSessions.set(uploadId, { filename, fileSize: +fileSize, totalChunks: +totalChunks });
  }
  const received = fs.readdirSync(sessionDir).filter(f => f.indexOf('chunk_') === 0).length;
  res.json({ ok: true, received, total: +totalChunks });
});

app.post('/api/finalize-upload', (req, res) => {
  const { uploadId } = req.body;
  if (!isLoopback(req) && !LAN_MODE) { res.status(403).json({ error: 'Forbidden.' }); return; }
  const sess = uploadSessions.get(uploadId);
  if (!sess) { res.status(400).json({ error: 'Unknown upload session.' }); return; }

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  const mergedPath = path.join(TMP_UPLOADS, 'up_' + uploadId + '_' + sess.filename.replace(/[\\/:*?"<>|]/g, '_'));
  const ws = fs.createWriteStream(mergedPath);
  let ok = true;

  for (let i = 0; i < sess.totalChunks; i++) {
    const cp = path.join(sessionDir, 'chunk_' + i);
    if (!fs.existsSync(cp)) { ok = false; break; }
    ws.write(fs.readFileSync(cp));
  }
  ws.end();

  ws.on('finish', () => {
    uploadSessions.delete(uploadId);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    if (!ok) { res.status(400).json({ error: 'Missing chunk(s).' }); return; }
    res.json({ ok: true, path: mergedPath });
  });
  ws.on('error', e => res.status(500).json({ error: e.message }));
});

app.post('/api/extract-from-path', async (req, res) => {
  // security model:
  //   loopback clients      -> may reference any local path
  //   LAN clients (LAN=1)   -> only paths inside this app's tmp_uploads dir
  const { filePath, format = 'm4a' } = req.body || {};
  const requested = filePath || '';
  const fullLoopbackPass = isLoopback(req);
  if (!fullLoopbackPass && !LAN_MODE) {
    res.status(403).json({ error: 'This endpoint accepts localhost calls only.' }); return;
  }
  if (!requested || !FORMAT_MAP[format]) { res.status(400).json({ error: 'Bad parameters.' }); return; }
  let full = path.isAbsolute(requested) ? requested : path.join(ROOT, requested);
  if (!fullLoopbackPass) {
    const resolved = path.resolve(full);
    if (!resolved.startsWith(TMP_UPLOADS + path.sep)) {
      res.status(403).json({ error: 'Forbidden path.' }); return;
    }
  }
  if (!fs.existsSync(full)) { res.status(404).json({ error: 'File not found.' }); return; }
  if (activeJobs >= MAX_CONCURRENT_JOBS) { res.status(429).json({ error: 'Server busy.' }); return; }
  try {
    const result = await extract(full, format);
    const safeName = path.basename(full, path.extname(full)).replace(/[\\/:*?"<>|]/g, '_') || 'audio';
    res.json({
      ok: true,
      downloadName: safeName + FORMAT_MAP[format].ext,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  lanMode: LAN_MODE,
  jobs: activeJobs,
  formats: Object.keys(FORMAT_MAP)
}));

// ---------- listen with port fallback ----------
function openBrowser(url) {
  if (process.env.AUDIO_EXTRACTOR_NO_OPEN === '1') return;
  exec('powershell -NoProfile -Command "Start-Process \'' + url + '\'"', () => {});
}

function listen(port, triesLeft) {
  const server = app.listen(port, HOST, () => {
    const shownHost = LAN_MODE ? hostIps() : ['127.0.0.1'];
    console.log('');
    console.log('  audio-extractor is running.');
    shownHost.forEach(h => console.log('  open  ->  http://' + h + ':' + port));
    console.log('  stop  ->  close this window');
    console.log('');
    openBrowser('http://127.0.0.1:' + port);
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('[!] Port ' + port + ' is busy, trying ' + (port + 1) + ' ...');
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('[FATAL] Could not bind a port: ' + e.message);
      process.exit(1);
    }
  });
}

function hostIps() {
  const ifs = require('os').networkInterfaces();
  const ips = [];
  for (const list of Object.values(ifs)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips.length ? ips : ['0.0.0.0'];
}

// ---------- boot ----------
console.log('[init] ffmpeg : ' + (FFMPEG === 'ffmpeg' ? '(from PATH)' : FFMPEG));
verifyFfmpeg(err => {
  if (err) {
    console.error('[FATAL] ' + err.message);
    try { require('fs').writeFileSync(path.join(ROOT, 'ffmpeg-error.txt'), err.message); } catch (_) {}
    process.exit(1);
  } else {
    listen(START_PORT, MAX_PORT_TRIES);
  }
});
