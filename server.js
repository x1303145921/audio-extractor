const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8912;
const upload = multer({
  dest: 'tmp_uploads/',
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4 GB
});
const FFMPEG = 'D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe';
const CHUNK_DIR = path.join(__dirname, 'tmp_chunks');
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

function withExt(inputPath, ext) { return inputPath.replace(/\.[^.]+$/, '') + '.' + ext; }

const FORMAT_MAP = {
  m4a:  { codec: 'aac',       ext: '.m4a',  args: ['-acodec', 'aac',       '-b:a', '192k'] },
  mp3:  { codec: 'libmp3lame', ext: '.mp3',  args: ['-acodec', 'libmp3lame', '-q:a', '2']    },
  wav:  { codec: 'pcm_s16le',  ext: '.wav',  args: ['-acodec', 'pcm_s16le']                   },
  flac: { codec: 'flac',       ext: '.flac', args: ['-acodec', 'flac']                        },
  opus: { codec: 'libopus',    ext: '.opus',  args: ['-acodec', 'libopus',    '-b:a', '128k'] },
};

function timeToSec(s) {
  const m = s.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function extract(inputPath, format) {
  return new Promise((resolve, reject) => {
    const fmt = FORMAT_MAP[format];
    if (!fmt) return reject(new Error('不支持的格式'));

    // M4A/Opus 使用 stream copy（容器级拷贝，零重编、约 10x 加速）
    const copyMode = (format === 'm4a' || format === 'opus');
    const args = [
      '-i', inputPath,
      '-vn',
      ...(copyMode ? ['-c:a', 'copy'] : fmt.args),
      '-y',
      withExt(inputPath, fmt.ext),
    ];

    const ff = spawn(FFMPEG, args);
    let stderr = '';
    let duration = 0;
    let lastProgress = 0;
    let progressCb = null;

    const onProgress = (pct) => {
      if (pct !== lastProgress) {
        lastProgress = pct;
        if (progressCb) progressCb(pct);
      }
    };

    ff.stderr.on('data', d => {
      stderr += d.toString();
      if (!duration) {
        const dm = stderr.match(/Duration=([\d:.]+)/);
        if (dm) duration = timeToSec(dm[1]);
      }
      const tm = stderr.match(/time=([\d:.]+)/);
      if (tm && duration > 0) {
        const cur = timeToSec(tm[1]);
        onProgress(Math.min(99, Math.round((cur / duration) * 100)));
      }
    });

    ff.on('close', code => {
      fs.unlink(inputPath, () => {});
      if (code !== 0) {
        console.error('[ffmpeg]', stderr.slice(-400));
        return reject(new Error('转码失败：文件可能损坏或不支持的编码'));
      }
      const out = withExt(inputPath, fmt.ext);
      if (!fs.existsSync(out)) return reject(new Error('输出文件未生成'));
      const size = fs.statSync(out).size;
      onProgress(100);
      resolve({ path: out, size });
    });
  });
}

app.post('/api/extract', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
  const filePath = req.file?.path;
  if (!filePath || typeof filePath !== 'string') {
    console.error('[server] req.file.path missing, file keys:', Object.keys(req.file));
    return res.status(400).json({ error: '服务器未正确接收文件，请重试' });
  }
  const { format = 'm4a' } = req.body;
  if (!FORMAT_MAP[format]) return res.status(400).json({ error: '不支持的格式: ' + format });

  // progress callback via SSE
  res.setHeader('Content-Type', 'application/json');
  const sendProgress = (pct) => {
    // SSE not used in this simplified version; just wait for final result
  };

  try {
    const result = await extract(req.file.path, format);
    const basename = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const dlName = basename + FORMAT_MAP[format].ext;
    res.json({
      ok: true,
      progress: 100,
      downloadName: dlName,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/download', (req, res) => {
  const raw = decodeURIComponent(req.query.file || '');
  const safe = path.basename(raw);
  if (!safe) return res.status(400).send('Bad request');
  const file = path.join(__dirname, 'tmp_uploads', safe);
  if (!file.startsWith(path.join(__dirname, 'tmp_uploads') + path.sep)) return res.status(400).send('Bad request');
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.download(file);
});

// ---------- Chunked Upload ----------
const uploadSessions = new Map();

app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename, fileSize } = req.body;
  if (!uploadId || req.file == null) return res.status(400).json({ error: '缺少参数' });

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const chunkPath = path.join(sessionDir, `chunk_${chunkIndex}`);
  fs.renameSync(req.file.path, chunkPath);

  if (!uploadSessions.has(uploadId)) {
    uploadSessions.set(uploadId, { filename, fileSize: +fileSize, totalChunks: +totalChunks, received: 0 });
  }
  const sess = uploadSessions.get(uploadId);
  sess.received++;

  res.json({ ok: true, received: sess.received, total: sess.totalChunks });
});

app.post('/api/finalize-upload', async (req, res) => {
  const { uploadId } = req.body;
  const sess = uploadSessions.get(uploadId);
  if (!sess) return res.status(400).json({ error: '不存在此上传会话' });

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  const mergedPath = path.join('tmp_uploads', `upload_${uploadId}_${sess.filename}`);
  const writeStream = fs.createWriteStream(mergedPath);

  for (let i = 0; i < sess.totalChunks; i++) {
    const chunkPath = path.join(sessionDir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      writeStream.destroy();
      return res.status(400).json({ error: `分片 ${i} 缺失` });
    }
    writeStream.write(fs.readFileSync(chunkPath));
  }
  writeStream.end();

  writeStream.on('finish', () => {
    uploadSessions.delete(uploadId);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    res.json({ ok: true, path: mergedPath });
  });
  writeStream.on('error', e => res.status(500).json({ error: e.message }));
});

app.get('/api/upload-status', (req, res) => {
  const { uploadId } = req.query;
  const sess = uploadSessions.get(uploadId);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  res.json({ received: sess.received, total: sess.totalChunks });
});

// ---------- Extract from server path (for chunked uploads) ----------
app.post('/api/extract-from-path', async (req, res) => {
  const { filePath, format = 'm4a' } = req.body;
  if (!filePath || !FORMAT_MAP[format]) return res.status(400).json({ error: '参数错误' });
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件不存在' });
  try {
    const result = await extract(fullPath, format);
    const safeName = path.basename(fullPath, path.extname(fullPath));
    const dlName = safeName + FORMAT_MAP[format].ext;
    res.json({ ok: true, downloadName: dlName, size: result.size, outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, ffmpeg: FFMPEG }));

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const ifs = networkInterfaces();
  const ips = Object.values(ifs).flat().filter(i => !i.internal && i.family === 'IPv4').map(i => i.address);
  console.log(`[audio-extractor] 本地: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`[audio-extractor] 局域网: http://${ip}:${PORT}`));
});