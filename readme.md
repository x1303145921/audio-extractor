# 音频提取工具

从视频文件中提取音频，支持 M4A / MP3 / WAV / FLAC / Opus 五种格式。

## 运行

```bash
node server.js
```

浏览器打开 **http://localhost:8912**（本地）
或 **http://[你电脑的局域网IP]:8912**（手机同 WiFi 访问，启动脚本会自动打印 IP）

## PWA（手机作为 APP 使用）

Android：Chrome 菜单 → 「添加到主屏幕」→ 点图标全屏打开

iOS：Safari 分享按钮 → 「添加到主屏幕」→ 点图标全屏打开

> 添加后无地址栏、无浏览器 UI，接近原生应用体验。

## 大文件上传（>50 MB）

前端自动使用分片上传，避免手机浏览器单次上传失败。

## 新增文件

- `manifest.json` — PWA 配置
- `service-worker.js` — 离线缓存（静态资源）
- `public/index.html` — 前端新增安装提示条、分片上传逻辑
- `server.js` — 新增 `/api/upload-chunk` `/api/finalize-upload` `/api/extract-from-path`，监听 `0.0.0.0:8912`

## 原理

视频是容器格式，画面和音频是两个独立流。FFmpeg 按以下逻辑工作：

```
视频文件 → FFmpeg -vn（丢弃视频流）→ 指定编码器 → 输出音频文件
```

例如提取 M4A：
```bash
ffmpeg -i input.mp4 -vn -acodec aac -b:a 192k output.m4a
```

仅用一行命令完成。

## 依赖

- Node.js + express + multer
- FFmpeg（已安装在 `D:\Tools\ffmpeg\bin\`，加入用户 PATH）

## 格式说明

| 格式 | 编码器 | 特点 | 适用场景 |
|---|---|---|---|
| M4A | AAC | 体积小、兼容好 | 一般用途，**推荐** |
| MP3 | libmp3lame | 最通用 | 需要最大兼容性 |
| WAV | PCM | 无损、体积大 | 专业音频处理 |
| FLAC | FLAC | 无损、体积中等 | 高质量归档 |
| Opus | libopus | 压缩率最高 | 互联网传输、低带宽 |