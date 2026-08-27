const express = require('express');
const multer = require('multer');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================
// 音频提取工具 v1.1.0
// 路径全部基于 __dirname，与进程启动目录无关
// 环境变量：
//   PORT              监听端口（默认 8912）
//   FFMPEG_PATH       指定 ffmpeg 可执行文件路径
//   MAX_EXTRACT_JOBS  同时转码的任务数上限（默认 2）
// ============================================================

const app = express();
const PORT = Math.max(1, parseInt(process.env.PORT || '8912', 10));

// ---------- 目录常量 ----------
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'tmp_uploads');
const CHUNK_DIR = path.join(ROOT, 'tmp_chunks');
for (const d of [UPLOAD_DIR, CHUNK_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- FFmpeg 解析：环境变量 → PATH → 本机默认路径 ----------
function resolveFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    if (!probe.error && probe.status === 0) return 'ffmpeg';
  } catch (_) { /* PATH 中没有，继续回退 */ }
  const fallback = 'D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe';
  if (fs.existsSync(fallback)) return fallback;
  return null;
}
const FFMPEG = resolveFfmpegPath();

// ---------- 注册表 ----------
// 分片上传会话（内存态；重启即失效，残片由启动清扫回收）
const uploadSessions = new Map();
// 转码进度任务 { status: queued|transcoding|done|failed, pct, error, createdAt, finishedAt }
const extractJobs = new Map();

// ---------- 定时清理：防止临时数据无限蚕食磁盘 ----------
const SESSION_IDLE_MS = 30 * 60 * 1000;    // 上传会话闲置 30 分钟视为中断
const FILE_STALE_MS = 6 * 60 * 60 * 1000;  // 临时文件保留 6 小时
const JOB_TTL_MS = 1 * 60 * 60 * 1000;     // 进度任务记录保留 1 小时

function sweepOnce() {
  const now = Date.now();
  // 1) 过期上传会话及其分片目录
  for (const [id, s] of uploadSessions) {
    if (now - s.lastActivity > SESSION_IDLE_MS) {
      uploadSessions.delete(id);
      fs.rm(path.join(CHUNK_DIR, id), { recursive: true, force: true }, () => {});
      console.log(`[cleanup] 过期上传会话已清理: ${id}`);
    }
  }
  // 2) 孤儿分片目录（无会话且闲置超时）
  try {
    for (const ent of fs.readdirSync(CHUNK_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(CHUNK_DIR, ent.name);
      try {
        if (now - fs.statSync(dir).mtimeMs > SESSION_IDLE_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[cleanup] 孤儿分片目录已清理: ${ent.name}`);
        }
      } catch (_) { /* 单个失败不影响整体 */ }
    }
  } catch (_) { /* CHUNK_DIR 读不到就跳过 */ }
  // 3) 过期临时文件（multer 中间文件 / 合并输入 / 输出成品）
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const fp = path.join(UPLOAD_DIR, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > FILE_STALE_MS) fs.rmSync(fp, { force: true });
      } catch (_) { /* 忽略单个 */ }
    }
  } catch (_) { /* 同上 */ }
  // 4) 过期进度任务
  for (const [id, j] of extractJobs) {
    const ref = j.finishedAt || j.createdAt;
    if (now - ref > JOB_TTL_MS) extractJobs.delete(id);
  }
}
setInterval(sweepOnce, 15 * 60 * 1000).unref();

// 启动清扫：上次运行残留的分片目录一律清掉（会话在内存里，重启后必成孤儿）
(function startupCleanup() {
  let n = 0;
  try {
    for (const ent of fs.readdirSync(CHUNK_DIR, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        fs.rmSync(path.join(CHUNK_DIR, ent.name), { recursive: true, force: true });
        n++;
      }
    }
  } catch (_) { /* 忽略 */ }
  if (n > 0) console.log(`[cleanup] 已清扫上次运行残留的分片目录 ${n} 个`);
})();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4 GB
});

function withExt(inputPath, ext) { return inputPath.replace(/\.[^.]+$/, '') + '.' + ext; }

const FORMAT_MAP = {
  m4a:  { codec: 'aac',       ext: '.m4a',  args: ['-acodec', 'aac',        '-b:a', '192k'] },
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
app.use(express.static(path.join(ROOT, 'public')));

function insideRoot(p) {
  const rp = path.resolve(p);
  return rp === ROOT || rp.startsWith(ROOT + path.sep);
}

// 安全会话 ID：只允许字母数字下划线连字符，防路径穿越
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// ---------- 并发限制：同一时间最多 MAX_EXTRACT_JOBS 个转码任务 ----------
const MAX_EXTRACT_JOBS = Math.max(1, parseInt(process.env.MAX_EXTRACT_JOBS || '2', 10));
let activeExtracts = 0;
const pendingExtracts = [];

function acquireSlot(label) {
  return new Promise(resolve => {
    if (activeExtracts < MAX_EXTRACT_JOBS) {
      activeExtracts++;
      return resolve();
    }
    console.log(`[queue] 任务排队中: ${label} (当前 ${activeExtracts}/${MAX_EXTRACT_JOBS})`);
    pendingExtracts.push(() => { activeExtracts++; resolve(); });
  });
}

function releaseSlot() {
  activeExtracts--;
  const next = pendingExtracts.shift();
  if (next) next();
}

// 新建或复用进度任务
function ensureJob(rawId) {
  const jobId = (typeof rawId === 'string' && rawId.length >= 6 && rawId.length <= 80)
    ? rawId.replace(/[^A-Za-z0-9_-]/g, '_')
    : `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (!extractJobs.has(jobId)) {
    extractJobs.set(jobId, { status: 'queued', pct: 0, error: null, createdAt: Date.now(), finishedAt: null });
  }
  return { jobId, job: extractJobs.get(jobId) };
}

// ---------- 转码核心 ----------
// onProgress(pct)：可选进度回调，pct ∈ [0,100]
// M4A/Opus 优先尝试 stream copy（容器级拷贝，零重编、约 10x 加速）；
// 源音轨编码与目标容器不兼容时自动回退重编码
function extract(inputPath, format, onProgress) {
  const fmt = FORMAT_MAP[format];
  if (!fmt) return Promise.reject(new Error('不支持的格式'));
  const preferCopy = (format === 'm4a' || format === 'opus');
  const outPath = withExt(inputPath, fmt.ext);

  // 单次 ffmpeg 尝试；copy=true 时走流拷贝，否则按 FORMAT_MAP 重编码
  const attempt = (copy) => new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vn',
      ...(copy ? ['-c:a', 'copy'] : fmt.args),
      '-y',
      outPath,
    ];

    const ff = spawn(FFMPEG, args);
    let stderr = '';
    let duration = 0;
    let lastProgress = 0;

    const report = (pct) => {
      if (typeof onProgress === 'function' && pct !== lastProgress) {
        lastProgress = pct;
        onProgress(pct);
      }
    };

    ff.on('error', err => {
      reject(Object.assign(new Error('无法启动 FFmpeg：' + err.message), { fatal: true }));
    });

    ff.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024); // 防超长占用内存
      if (!duration) {
        // FFmpeg 输出格式为 "Duration: HH:MM:SS.ms"
        const dm = stderr.match(/Duration:\s*([\d:.]+)/);
        if (dm) duration = timeToSec(dm[1]);
      }
      const tm = stderr.match(/time=([\d:.]+)/);
      if (tm && duration > 0) {
        const cur = timeToSec(tm[1]);
        report(Math.min(99, Math.round((cur / duration) * 100)));
      }
    });

    ff.on('close', code => {
      if (code !== 0) return reject(new Error('FFMPEG_FAIL'));
      if (!fs.existsSync(outPath)) return reject(new Error('输出文件未生成'));
      resolve(fs.statSync(outPath).size);
    });
  });

  const finish = (size) => {
    fs.unlink(inputPath, () => {});
    return { path: outPath, size };
  };
  const failWith = (msg) => {
    fs.unlink(inputPath, () => {});
    return Promise.reject(new Error(msg));
  };

  if (preferCopy) {
    return attempt(true).then(
      size => finish(size),
      err => {
        if (err.fatal) return failWith(err.message);
        console.log(`[extract] stream copy 失败（源音轨与目标容器不兼容），回退重编码: ${path.basename(outPath)}`);
        return attempt(false).then(
          size => finish(size),
          e2 => e2.fatal ? failWith(e2.message) : failWith('转码失败：文件可能损坏或不支持的编码')
        );
      }
    );
  }

  return attempt(false).then(
    size => finish(size),
    err => err.fatal ? failWith(err.message) : failWith('转码失败：文件可能损坏或不支持的编码')
  );
}

// ---------- 转码统一入口：排队 → 执行 → 更新进度任务 ----------
async function runExtract(fullPath, format, jobId, job, label) {
  await acquireSlot(label);
  job.status = 'transcoding';
  console.log(`[extract] 开始 ${format}: ${label} (并发 ${activeExtracts}/${MAX_EXTRACT_JOBS})`);
  try {
    const result = await extract(fullPath, format, pct => { job.pct = pct; });
    job.status = 'done';
    job.pct = 100;
    job.finishedAt = Date.now();
    return result;
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    job.finishedAt = Date.now();
    throw e;
  } finally {
    releaseSlot();
  }
}

// ================= API =================

app.post('/api/extract', upload.single('video'), async (req, res) => {
  if (!FFMPEG) return res.status(500).json({ error: '服务器未找到 FFmpeg：请安装 FFmpeg 并加入 PATH，或设置环境变量 FFMPEG_PATH' });
  if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
  const filePath = req.file?.path;
  if (!filePath || typeof filePath !== 'string') {
    console.error('[server] req.file.path missing, file keys:', Object.keys(req.file));
    return res.status(400).json({ error: '服务器未正确接收文件，请重试' });
  }
  const { format = 'm4a' } = req.body;
  if (!FORMAT_MAP[format]) return res.status(400).json({ error: '不支持的格式: ' + format });

  const { jobId, job } = ensureJob(req.body.jobId);
  const label = req.file.originalname || path.basename(filePath);

  try {
    const result = await runExtract(filePath, format, jobId, job, label);
    const basename = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const dlName = basename + FORMAT_MAP[format].ext;
    res.json({
      ok: true,
      jobId,
      progress: 100,
      downloadName: dlName,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, jobId });
  }
});

app.get('/api/download', (req, res) => {
  const raw = decodeURIComponent(req.query.file || '');
  const safe = path.basename(raw);
  if (!safe) return res.status(400).send('Bad request');
  const file = path.join(UPLOAD_DIR, safe);
  if (!insideRoot(file)) return res.status(400).send('Bad request');
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.download(file);
});

// ---------- 实时转码进度（SSE） ----------
app.get('/api/progress/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
  const job = extractJobs.get(id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = () => {
    try {
      res.write(`data: ${JSON.stringify({ status: job.status, pct: job.pct, error: job.error })}\n\n`);
    } catch (_) { /* 连接断开 */ }
  };
  send();

  const timer = setInterval(() => {
    if (job.status === 'done' || job.status === 'failed') {
      send();
      clearInterval(timer);
      try { res.end(); } catch (_) {}
      return;
    }
    send();
  }, 600);

  req.on('close', () => clearInterval(timer));
});

// ---------- 分片上传 ----------
app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename, fileSize } = req.body;
  if (!uploadId || !UPLOAD_ID_RE.test(uploadId)) return res.status(400).json({ error: 'uploadId 非法' });
  if (req.file == null) return res.status(400).json({ error: '缺少参数' });
  if (!uploadSessions.has(uploadId)) {
    uploadSessions.set(uploadId, {
      filename: path.basename(String(filename || 'video')),
      fileSize: +fileSize || 0,
      totalChunks: Math.max(1, +totalChunks || 1),
      received: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }
  const sess = uploadSessions.get(uploadId);
  sess.lastActivity = Date.now();

  const idx = parseInt(chunkIndex, 10);
  if (!(idx >= 0 && idx < sess.totalChunks)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'chunkIndex 超出范围' });
  }

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const chunkPath = path.join(sessionDir, `chunk_${idx}`);
  fs.renameSync(req.file.path, chunkPath);
  sess.received++;

  res.json({ ok: true, received: sess.received, total: sess.totalChunks });
});

// 流式顺序合并：全程只有流缓冲占内存，不阻塞事件循环
function mergeChunks(sessionDir, totalChunks, outPath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    let idx = 0;
    let failed = false;

    ws.on('error', err => { failed = true; reject(err); });
    ws.on('finish', () => resolve());

    const next = () => {
      if (failed) return;
      if (idx >= totalChunks) { ws.end(); return; }
      const src = path.join(sessionDir, `chunk_${idx++}`);
      const rs = fs.createReadStream(src);
      rs.on('error', err => {
        failed = true;
        ws.destroy();
        reject(new Error(`读取分片失败(${path.basename(src)})：${err.message}`));
      });
      rs.pipe(ws, { end: false });
      rs.on('end', next);
    };
    next();
  });
}

app.post('/api/finalize-upload', async (req, res) => {
  const { uploadId } = req.body || {};
  if (!uploadId || !UPLOAD_ID_RE.test(uploadId)) return res.status(400).json({ error: 'uploadId 非法' });
  const sess = uploadSessions.get(uploadId);
  if (!sess) return res.status(400).json({ error: '不存在此上传会话（可能已过期或服务重启过）' });

  const sessionDir = path.join(CHUNK_DIR, uploadId);

  // 先校验所有分片齐全，再开始合并
  for (let i = 0; i < sess.totalChunks; i++) {
    if (!fs.existsSync(path.join(sessionDir, `chunk_${i}`))) {
      return res.status(400).json({ error: `分片 ${i} 缺失，请重新上传该文件` });
    }
  }

  const mergedName = `upload_${uploadId}_${sess.filename}`;
  const mergedPath = path.join(UPLOAD_DIR, mergedName); // 绝对路径，不受启动目录影响
  const relPath = path.relative(ROOT, mergedPath);

  try {
    await mergeChunks(sessionDir, sess.totalChunks, mergedPath);
    uploadSessions.delete(uploadId);
    fs.rmSync(sessionDir, { recursive: true, force: true }, () => {});
    console.log(`[merge] 合并完成: ${mergedName} (${sess.totalChunks} 分片)`);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    fs.rmSync(mergedPath, { force: true }, () => {});
    res.status(500).json({ error: '合并失败：' + e.message });
  }
});

app.get('/api/upload-status', (req, res) => {
  const { uploadId } = req.query;
  const sess = uploadSessions.get(String(uploadId || ''));
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  res.json({ received: sess.received, total: sess.totalChunks });
});

// ---------- 服务端已有文件的提取（配合分片上传） ----------
app.post('/api/extract-from-path', async (req, res) => {
  if (!FFMPEG) return res.status(500).json({ error: '服务器未找到 FFmpeg：请安装 FFmpeg 并加入 PATH，或设置环境变量 FFMPEG_PATH' });
  const { filePath, format = 'm4a' } = req.body || {};
  if (!filePath || !FORMAT_MAP[format]) return res.status(400).json({ error: '参数错误' });

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!insideRoot(fullPath)) return res.status(403).json({ error: '路径越界，仅允许处理本工具目录内的文件' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件不存在' });

  const { jobId, job } = ensureJob(req.body.jobId);
  try {
    const result = await runExtract(fullPath, format, jobId, job, path.basename(fullPath));
    const safeName = path.basename(fullPath, path.extname(fullPath));
    const dlName = safeName + FORMAT_MAP[format].ext;
    res.json({
      ok: true,
      jobId,
      downloadName: dlName,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, jobId });
  }
});

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({
  ok: true,
  version: '1.1.0',
  ffmpeg: !!FFMPEG,
  ffmpegResolved: FFMPEG,
  maxConcurrent: MAX_EXTRACT_JOBS,
}));

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const ifs = networkInterfaces();
  const ips = Object.values(ifs).flat().filter(i => !i.internal && i.family === 'IPv4').map(i => i.address);
  console.log(`[audio-extractor] v1.1.0 已启动`);
  console.log(`[audio-extractor] 本地: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`[audio-extractor] 局域网: http://${ip}:${PORT}`));
  console.log(`[audio-extractor] FFmpeg: ${FFMPEG ? FFMPEG : '⚠ 未找到！请安装并加入 PATH，或设置 FFMPEG_PATH'}`);
  console.log(`[audio-extractor] 转码并发上限: ${MAX_EXTRACT_JOBS}`);
});
