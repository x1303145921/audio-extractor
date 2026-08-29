const express = require('express');
const multer = require('multer');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// 音频提取工具（版本号统一取自 package.json，bump 时只需改一处）
// 路径全部基于 __dirname，与进程启动目录无关
// 环境变量：
//   PORT              监听端口（默认 8912）
//   FFMPEG_PATH       指定 ffmpeg 可执行文件路径
//   MAX_EXTRACT_JOBS  同时转码的任务数上限（默认 2）
// ============================================================

const app = express();
// 监听地址：默认全部网卡（保持旧行为，方便手机局域网访问）；可用 BIND 收紧
// 例：BIND=127.0.0.1 node server.js （仅本机可用，更安全）
const BIND = process.env.BIND || '0.0.0.0';
const BASE_PORT = Math.max(1, parseInt(process.env.PORT || '8912', 10));
const PORT_RANGE = 10; // 端口被占用时向后顺延的最大尝试数
const VERSION = require('./package.json').version;

// ---------- 目录常量 ----------
const ROOT = __dirname;

// 临时目录可写自检：便携包解压到管理员创建的目录（如 D:\Tools）时，ACL 通常只给
// Administrators 写权限，普通用户双击启动的服务会因 EPERM 无法写入临时文件（提取失败）。
// 这里先探测可写性，不可写则回退到系统临时目录（%TEMP%\audio-extractor），保证开箱即用。
function ensureWritableDir(dir) {
  const probe = path.join(dir, `.wprobe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return dir;
  } catch (e) {
    console.warn(`[server] ${dir} 不可写(${e.code})，已回退到系统临时目录`);
    const fallback = path.join(os.tmpdir(), 'audio-extractor', path.basename(dir));
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch (_) { /* 最后兜底：原目录继续用，后续请求会报错 */ }
    return fallback;
  }
}
const UPLOAD_DIR = ensureWritableDir(path.join(ROOT, 'tmp_uploads'));
const CHUNK_DIR = ensureWritableDir(path.join(ROOT, 'tmp_chunks'));
console.log(`[server] 临时上传目录: ${UPLOAD_DIR}`);
console.log(`[server] 临时分片目录: ${CHUNK_DIR}`);

// ---------- FFmpeg 解析：环境变量 → PATH → 随包自带的 ffmpeg-bin → 本机默认路径 ----------
function resolveFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    if (!probe.error && probe.status === 0) return 'ffmpeg';
  } catch (_) { /* PATH 中没有，继续回退 */ }
  // 便携版随包位置：server.js 同目录的 ffmpeg-bin\，或直接躺在旁边的 ffmpeg.exe
  const bundled = path.join(ROOT, 'ffmpeg-bin', 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;
  const flatBundled = path.join(ROOT, 'ffmpeg.exe');
  if (fs.existsSync(flatBundled)) return flatBundled;
  const fallback = 'D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe';
  if (fs.existsSync(fallback)) return fallback;
  return null;
}
const FFMPEG = resolveFfmpegPath();

// ---------- 注册表 ----------
// 分片上传会话（内存态；重启即失效，残片由启动清扫回收）
const uploadSessions = new Map();
// 转码进度任务 { status, pct, error, createdAt, finishedAt, proc, cancelled }
const extractJobs = new Map();
// 进行中的合并操作（防同一会话并发 finalize）
const finalizingIds = new Set();

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
  // 4) 过期进度任务（进行中的任务绝不清扫）
  for (const [id, j] of extractJobs) {
    if (j.status === 'queued' || j.status === 'transcoding') continue;
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

// 输出路径 = 源文件目录 + 去扩展名后的文件名 + 目标扩展名。
// 用 path.extname 只取「最后一个路径段」的扩展名，避免误伤路径中带点的目录
// （如 D:\app.v2\tmp\file → 旧正则 /\.[^.]+$/ 会把 .v2\tmp\file 整段当扩展名删掉，
//  导致输出写到错误位置）；ext 本身带点（如 '.mp3'），拼接前去掉前导点防双点。
function withExt(inputPath, ext) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, base + '.' + String(ext).replace(/^\./, ''));
}

// multer/busboy 把 multipart 里的 filename 按 Latin-1 解码，UTF-8 中文会变成 mojibake
// （如「我的测试视频」→「茅聨麓忙聢聽忙庐聭」）。此函数还原被误解码的文件名：
// 仅当字符串“含高位字符且全部码点 ≤ 0xFF”（Latin-1 误解码特征）时才尝试还原，
// 正常的 Unicode 文件名 / 纯 ASCII 名原样返回，绝不误伤。
function fixUtf8Name(name) {
  if (!name) return name;
  let hasHigh = false, allLatin1 = true;
  for (const ch of String(name)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFF) { allLatin1 = false; break; }
    if (cp > 0x7F) hasHigh = true;
  }
  if (!hasHigh || !allLatin1) return name;
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? name : fixed;
}

const FORMAT_MAP = {
  m4a:  { codec: 'aac',       ext: '.m4a',  args: ['-acodec', 'aac',        '-b:a', '192k'] },
  mp3:  { codec: 'libmp3lame', ext: '.mp3',  args: ['-acodec', 'libmp3lame', '-q:a', '2']    },
  wav:  { codec: 'pcm_s16le',  ext: '.wav',  args: ['-acodec', 'pcm_s16le']                   },
  flac: { codec: 'flac',       ext: '.flac', args: ['-acodec', 'flac']                        },
  opus: { codec: 'libopus',    ext: '.opus',  args: ['-acodec', 'libopus',    '-b:a', '128k'] },
};

// ---------- 输出文件名与高级选项的安全校验 ----------
// outputName 来自请求体，必须收敛为纯文件名：防路径穿越（..\ ..\ / 绝对路径）、
// 非法字符、超长；不带目标扩展名时自动补上。清洗后为空则返回 null（走默认命名）。
function sanitizeOutputName(raw, ext) {
  if (raw == null) return null;
  let n = path.basename(String(raw)).trim();
  n = n.replace(/[\\/:*?"<>|\r\n\t\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!n || /^_+$/.test(n) || n.length > 120) return null;
  if (!n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

// 高级转码选项：白名单校验，非法值一律忽略（保持默认行为）
const ADV_BITRATES = ['128k', '192k', '320k'];
const ADV_SAMPLERATES = ['44100', '48000', '96000'];
const ADV_CHANNELS = ['1', '2'];
function sanitizeAdvOpts(body) {
  const b = body || {};
  const opts = {};
  if (ADV_BITRATES.includes(b.bitrate)) opts.bitrate = b.bitrate;
  if (ADV_SAMPLERATES.includes(String(b.sampleRate))) opts.sampleRate = String(b.sampleRate);
  if (ADV_CHANNELS.includes(String(b.channels))) opts.channels = String(b.channels);
  return opts;
}
// 生成最终编码参数：显式比特率时移除 mp3 的 -q:a（VBR 质量与 CBR 比特率冲突，后者优先）；
// ffmpeg 对重复参数取最后一次出现的值，追加即可覆盖 FORMAT_MAP 默认值
function buildCodecArgs(format, opts) {
  const a = [...FORMAT_MAP[format].args];
  if (!opts) return a;
  if (format === 'mp3' && opts.bitrate) {
    const qi = a.indexOf('-q:a');
    if (qi !== -1) a.splice(qi, 2);
  }
  if (opts.bitrate) a.push('-b:a', opts.bitrate);
  if (opts.sampleRate) a.push('-ar', opts.sampleRate);
  if (opts.channels) a.push('-ac', opts.channels);
  return a;
}

// ---------- FFmpeg 错误分类 ----------
const FFMPEG_ERROR_CODES = [
  { re: /Unknown encoder/i,                       code: 'ENCODER_MISSING',   hint: 'FFmpeg 缺少目标编码器，请检查 FFmpeg 版本' },
  { re: /Invalid data|could not find codec/i,     code: 'INVALID_INPUT',     hint: '源文件编码不兼容或文件已损坏，请确认文件可正常播放' },
  { re: /Permission denied/i,                     code: 'PERMISSION_DENIED', hint: '目录无写入权限，请换一个解压目录或以管理员权限运行' },
  { re: /No space left/i,                         code: 'DISK_FULL',         hint: '磁盘空间不足，请清理后重试' },
  { re: /Invalid argument/i,                      code: 'INVALID_ARGUMENT',  hint: '参数不合法，请检查输出格式是否正确' },
  { re: /File not found|No such file/i,           code: 'FILE_NOT_FOUND',    hint: '源文件不存在，请重新上传' },
  { re: /Error while opening/i,                   code: 'OPEN_FAILED',       hint: '无法打开源文件，请确认文件未被其他程序占用' },
];
const FFMPEG_ERROR_FALLBACK = { code: 'TRANSCODE_FAILED', hint: '转码失败：文件可能损坏或不支持的编码' };

function classifyFfmpegError(stderr) {
  const s = String(stderr || '');
  for (const e of FFMPEG_ERROR_CODES) {
    if (e.re.test(s)) return e;
  }
  return FFMPEG_ERROR_FALLBACK;
}

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

// 临时目录范围检查（UPLOAD_DIR 可能回退到 %TEMP%\audio-extractor）
function insideUploads(p) {
  const rp = path.resolve(p);
  return rp === UPLOAD_DIR || rp.startsWith(UPLOAD_DIR + path.sep);
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

// 新建或复用进度任务（jobId 清洗：只保留字母数字下划线连字符，上限 64 字符）
function ensureJob(rawId) {
  const sanitized = (typeof rawId === 'string' && rawId.length >= 6 && rawId.length <= 80)
    ? rawId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
    : null;
  const jobId = sanitized || `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  let job = extractJobs.get(jobId);
  if (!job) {
    job = { status: 'queued', pct: 0, error: null, createdAt: Date.now(), finishedAt: null, proc: null, cancelled: false };
    extractJobs.set(jobId, job);
  }
  return { jobId, job };
}

// 取消一个进行中的任务（杀掉其 FFmpeg 进程）
function cancelJob(jobId) {
  const job = extractJobs.get(String(jobId || ''));
  if (!job) return { ok: false, error: '任务不存在或已过期' };
  if (job.status !== 'queued' && job.status !== 'transcoding') return { ok: false, error: '任务已结束，无法取消' };
  job.cancelled = true;
  if (job.proc) { try { job.proc.kill(); } catch (_) {} }
  // 若还在排队未起进程，状态由 runExtract 在起跑前检查 cancelled 标志兑现
  return { ok: true };
}

// ---------- 转码核心 ----------
// job：进度任务对象（记录 proc 供取消，honored cancelled 标志）
// M4A/Opus/MP3/FLAC 优先尝试 stream copy（源音轨编码与输出容器匹配时无损直拷）；
// 源音轨与目标容器不兼容时自动回退重编码（v1.6.0 起 MP3/FLAC 也纳入流拷贝优先）
function extract(inputPath, format, job, outputName, opts) {
  const fmt = FORMAT_MAP[format];
  if (!fmt) return Promise.reject(new Error('不支持的格式'));
  const preferCopy = ['m4a', 'opus', 'mp3', 'flac'].includes(format);
  // v1.6.1 修复：用户显式设置高级选项（比特率/采样率/声道）时禁用流拷贝——
  // stream copy 无法应用这些参数，若源音轨匹配会直拷出源音质，导致 320k 等设置被静默忽略
  const hasAdvOpts = opts && (opts.bitrate || opts.sampleRate || opts.channels);
  const useCopy = preferCopy && !hasAdvOpts;
  // outputName 已由调用方 sanitizeOutputName 清洗（纯文件名，在 UPLOAD_DIR 内）
  const outPath = outputName ? path.join(UPLOAD_DIR, outputName) : withExt(inputPath, fmt.ext);

  // 单次 ffmpeg 尝试；copy=true 时走流拷贝，否则按 FORMAT_MAP 重编码
  const attempt = (copy) => new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(Object.assign(new Error('已取消'), { keepMsg: true }));
    const args = [
      '-i', inputPath,
      '-vn',
      ...(copy ? ['-c:a', 'copy'] : buildCodecArgs(format, opts)),
      '-y',
      outPath,
    ];

    const ff = spawn(FFMPEG, args);
    if (job) job.proc = ff;
    let stderr = '';
    const stderrLines = [];
    const MAX_STDERR_LINES = 200;
    let duration = 0;
    let lastProgress = 0;

    const report = (pct) => {
      if (job && typeof pct === 'number' && pct !== lastProgress) {
        lastProgress = pct;
        job.pct = pct;
      }
    };

    ff.on('error', err => {
      reject(Object.assign(new Error('无法启动 FFmpeg：' + err.message), { fatal: true }));
    });

    ff.stderr.on('data', d => {
      const text = d.toString();
      stderrLines.push(...text.split('\n'));
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.splice(0, stderrLines.length - MAX_STDERR_LINES);
      stderr = stderrLines.join('\n');
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
      if (job) job.proc = null;
      if (job && job.cancelled) return reject(Object.assign(new Error('已取消'), { keepMsg: true }));
      if (code !== 0) {
        const cls = classifyFfmpegError(stderr);
        // 不带 keepMsg：让 preferCopy 调用方能区分「编码不兼容可回退」与「取消/致命」
        return reject(Object.assign(new Error(cls.code), { code: cls.code, hint: cls.hint, stderr }));
      }
      if (!fs.existsSync(outPath)) return reject(new Error('输出文件未生成'));
      resolve(fs.statSync(outPath).size);
    });
  });

  const finish = (size) => {
    fs.unlink(inputPath, () => {});
    return { path: outPath, size };
  };
  const failWith = (msg, code, hint) => {
    fs.unlink(inputPath, () => {});
    // 取消/失败后清掉半成品输出
    fs.unlink(outPath, () => {});
    const err = Object.assign(new Error(msg), { keepMsg: true });
    if (code) { err.code = code; err.hint = hint || ''; }
    return Promise.reject(err);
  };

  if (useCopy) {
    return attempt(true).then(
      size => {
        if (job) job.mode = 'copy';
        console.log(`[extract] 流拷贝提取完成（无损直拷）: ${path.basename(outPath)}`);
        return finish(size);
      },
      err => {
        // 取消（keepMsg）/启动失败（fatal）：直接失败，不回退
        if (err.fatal || err.keepMsg) return failWith(err.message, err.code, err.hint);
        // 其余（流拷贝不兼容等）：回退重编码；拒绝对象已携带 code/hint，无需再分类
        if (job) job.mode = 'transcode';
        console.log(`[extract] stream copy 失败（源音轨与目标容器不兼容），回退重编码: ${path.basename(outPath)}`);
        return attempt(false).then(
          size => finish(size),
          e2 => failWith(e2.message, e2.code, e2.hint)
        );
      }
    );
  }

  return attempt(false).then(
    size => {
      if (job) job.mode = 'transcode';
      console.log(`[extract] 重编码提取完成: ${path.basename(outPath)}`);
      return finish(size);
    },
    // 拒绝对象已携带分类结果（code/hint）；此处不再引用 attempt 内部的 stderr（避免越界 ReferenceError）
    err => failWith(err.message, err.code, err.hint)
  );
}

// ---------- 转码统一入口：排队 → 执行 → 更新进度任务 ----------
async function runExtract(fullPath, format, jobId, job, label, outputName, opts) {
  await acquireSlot(label);
  try {
    if (job.cancelled) {
      job.status = 'failed';
      job.error = '已取消';
      job.finishedAt = Date.now();
      throw Object.assign(new Error('已取消'), { keepMsg: true });
    }
    job.status = 'transcoding';
    console.log(`[extract] 开始 ${format}: ${label} (并发 ${activeExtracts}/${MAX_EXTRACT_JOBS})`);
    const result = await extract(fullPath, format, job, outputName, opts);
    job.status = 'done';
    job.pct = 100;
    job.finishedAt = Date.now();
    return result;
  } catch (e) {
    job.status = 'failed';
    job.error = e.code ? `${e.code}: ${e.hint || e.message}` : e.message;
    if (e.code) { job.errorCode = e.code; job.errorHint = e.hint || ''; }
    job.finishedAt = Date.now();
    throw e;
  } finally {
    releaseSlot();
  }
}

// ================= API =================

app.post('/api/extract', upload.single('video'), async (req, res) => {
  if (!FFMPEG) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: '服务器未找到 FFmpeg：请安装 FFmpeg 并加入 PATH，或设置环境变量 FFMPEG_PATH' });
  }
  if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
  const filePath = req.file?.path;
  if (!filePath || typeof filePath !== 'string') {
    console.error('[server] req.file.path missing, file keys:', Object.keys(req.file));
    return res.status(400).json({ error: '服务器未正确接收文件，请重试' });
  }
  const { format = 'm4a' } = req.body;
  if (!FORMAT_MAP[format]) {
    fs.unlink(filePath, () => {});
    return res.status(400).json({ error: '不支持的格式: ' + format });
  }
  const outName = sanitizeOutputName(req.body.outputName, FORMAT_MAP[format].ext);
  const advOpts = sanitizeAdvOpts(req.body);

  const { jobId, job } = ensureJob(req.body.jobId);
  const label = fixUtf8Name(req.file.originalname) || path.basename(filePath);

  try {
    const result = await runExtract(filePath, format, jobId, job, label, outName, advOpts);
    const basename = path.basename(fixUtf8Name(req.file.originalname), path.extname(fixUtf8Name(req.file.originalname)));
    const dlName = outName || basename + FORMAT_MAP[format].ext;
    res.json({
      ok: true,
      jobId,
      progress: 100,
      mode: job.mode || null,
      downloadName: dlName,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)) + '&name=' + encodeURIComponent(dlName),
    });
  } catch (e) {
    const payload = { error: e.code ? `${e.code}: ${e.hint || e.message}` : e.message, jobId };
    if (e.code) payload.errorCode = e.code;
    res.status(500).json(payload);
  }
});

app.get('/api/download', (req, res) => {
  const raw = decodeURIComponent(req.query.file || '');
  const safe = path.basename(raw);
  if (!safe) return res.status(400).send('Bad request');
  const file = path.join(UPLOAD_DIR, safe);
  if (!insideUploads(file)) return res.status(400).send('Bad request');
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  // 磁盘上是随机 hash 名；这里用原始文件名作下载名（中文自动 RFC5987 编码），根治 hash 怪名
  const dl = path.basename(String(req.query.name || '').trim().replace(/[\\/:*?"<>|\r\n]/g, '_'));
  // dotfiles:'allow'：send 库默认 ignore 点开头路径段，解压目录/用户名含点目录（如 C:\Users\john.doe\...）
  // 时下载会 404；file 已通过 insideUploads 校验（限定在 UPLOAD_DIR 内），放开点目录段安全。
  if (dl) res.download(file, dl, { dotfiles: 'allow' });
  else res.download(file, { dotfiles: 'allow' });
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
      res.write(`data: ${JSON.stringify({ status: job.status, pct: job.pct, mode: job.mode || null, error: job.error, errorCode: job.errorCode || null, errorHint: job.errorHint || null })}\n\n`);
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

// ---------- 取消进行中的转码 ----------
app.post('/api/cancel/:id', (req, res) => {
  const result = cancelJob(req.params.id);
  res.status(result.ok ? 200 : 404).json(result);
});

// ---------- 分片上传 ----------
app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename, fileSize } = req.body;
  if (!uploadId || !UPLOAD_ID_RE.test(uploadId)) return res.status(400).json({ error: 'uploadId 非法' });
  if (req.file == null) return res.status(400).json({ error: '缺少参数' });
  if (!uploadSessions.has(uploadId)) {
    uploadSessions.set(uploadId, {
      filename: fixUtf8Name(path.basename(String(filename || 'video'))),
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
  // 竞态防护：同一会话只允许一次 finalize
  if (finalizingIds.has(uploadId)) return res.status(409).json({ error: '该上传正在合并中，请勿重复提交' });
  finalizingIds.add(uploadId);

  const sessionDir = path.join(CHUNK_DIR, uploadId);

  // 先校验所有分片齐全，再开始合并
  for (let i = 0; i < sess.totalChunks; i++) {
    if (!fs.existsSync(path.join(sessionDir, `chunk_${i}`))) {
      return res.status(400).json({ error: `分片 ${i} 缺失，请重新上传该文件` });
    }
  }

  const mergedName = `upload_${uploadId}_${sess.filename.replace(/[\\/:*?"<>|\r\n\t\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'video'}`;
  const mergedPath = path.join(UPLOAD_DIR, mergedName); // 绝对路径，不受启动目录影响
  const relPath = path.relative(UPLOAD_DIR, mergedPath);

  try {
    await mergeChunks(sessionDir, sess.totalChunks, mergedPath);
    uploadSessions.delete(uploadId);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`[merge] 合并完成: ${mergedName} (${sess.totalChunks} 分片)`);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    fs.rmSync(mergedPath, { force: true });
    res.status(500).json({ error: '合并失败：' + e.message });
  } finally {
    finalizingIds.delete(uploadId);
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
  const outName = sanitizeOutputName((req.body || {}).outputName, FORMAT_MAP[format].ext);
  const advOpts = sanitizeAdvOpts(req.body || {});

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(UPLOAD_DIR, filePath);
  if (!insideUploads(fullPath)) return res.status(403).json({ error: '路径越界，仅允许处理本工具临时目录内的文件' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件不存在' });

  const { jobId, job } = ensureJob(req.body.jobId);
  try {
    const result = await runExtract(fullPath, format, jobId, job, path.basename(fullPath), outName, advOpts);
    const safeName = path.basename(fullPath, path.extname(fullPath));
    const dlName = outName || safeName + FORMAT_MAP[format].ext;
    res.json({
      ok: true,
      jobId,
      mode: job.mode || null,
      downloadName: dlName,
      size: result.size,
      outputPath: '/api/download?file=' + encodeURIComponent(path.basename(result.path)) + '&name=' + encodeURIComponent(dlName),
    });
  } catch (e) {
    const payload = { error: e.code ? `${e.code}: ${e.hint || e.message}` : e.message, jobId };
    if (e.code) payload.errorCode = e.code;
    res.status(500).json(payload);
  }
});

// ---------- 退出服务（仅限本机触发；配合桌面快捷方式/静默启动器使用） ----------
const LOOPBACK_RE = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
function shutdownHandler(req, res) {
  const ra = req.socket.remoteAddress || '';
  if (!LOOPBACK_RE.test(ra)) return res.status(403).json({ error: '仅允许本机触发退出' });
  console.log('[audio-extractor] 收到本机退出请求，服务即将关闭');
  res.json({ ok: true, bye: true });
  setTimeout(() => process.exit(0), 250);
}
app.get('/api/quit', shutdownHandler);
app.post('/api/quit', shutdownHandler);

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({
  ok: true,
  version: VERSION,
  ffmpeg: !!FFMPEG,
  ffmpegResolved: FFMPEG,
  maxConcurrent: MAX_EXTRACT_JOBS,
}));

// ---------- 启动监听：端口被占用时自动顺延，最多尝试 PORT_RANGE 个 ----------
let currentPort = BASE_PORT;
function startListen() {
  const server = app.listen(currentPort, BIND, () => {
    const { networkInterfaces } = require('os');
    const ifs = networkInterfaces();
    const ips = Object.values(ifs).flat().filter(i => !i.internal && i.family === 'IPv4').map(i => i.address);
    console.log(`[audio-extractor] v${VERSION} 已启动`);
    console.log(`[audio-extractor] 本地: http://localhost:${currentPort}`);
    if (BIND === '0.0.0.0') ips.forEach(ip => console.log(`[audio-extractor] 局域网: http://${ip}:${currentPort}`));
    else console.log('[audio-extractor] (仅本机可访问; 设 BIND=0.0.0.0 可开放局域网)');
    console.log(`[audio-extractor] FFmpeg: ${FFMPEG ? FFMPEG : '⚠ 未找到！请安装并加入 PATH，或设置 FFMPEG_PATH'}`);
    console.log(`[audio-extractor] 转码并发上限: ${MAX_EXTRACT_JOBS}`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && currentPort < BASE_PORT + PORT_RANGE) {
      console.warn(`[audio-extractor] 端口 ${currentPort} 被占用，改用 ${currentPort + 1}`);
      currentPort++;
      startListen();
    } else {
      console.error(`[audio-extractor] 启动失败: ${err.message}`);
      process.exitCode = 1;
    }
  });
}
startListen();
