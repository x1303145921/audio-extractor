# 音频提取器 audio-extractor

本地视频转音频工具 —— 拖入视频，一键提取 M4A / MP3 / WAV / FLAC / Opus。
A local video-to-audio extractor for Windows. Drag & drop, five output formats, zero cloud.

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-bundled-orange">
</p>

## 特点 Features

- **解压即用**：自带 Node 运行时与 FFmpeg，无需安装任何依赖，双击 `start.bat` 就能跑
- **纯本地处理**：文件不离开你的电脑，没有上传云端环节
- **五种输出格式**：M4A（推荐）/ MP3 / WAV / FLAC / Opus
- **批量处理**：多文件排队依次转换，逐个出结果
- **大文件友好**：支持最大 4GB 视频；超过 50MB 自动分片上传，稳定可靠
- **进度实时可见**：基于 FFmpeg 输出解析的真实进度条
- **PWA 支持**：手机浏览器访问可「添加到主屏幕」，全屏近原生体验（需开启局域网模式）

## 快速开始 Quick Start

1. 下载 Release 中的 `audio-extractor-vX.X.X-win-x64.zip`
2. 解压到任意目录（建议路径不含特殊字符）
3. 双击 **`start.bat`**
   - 首次运行如遇 SmartScreen 提示：点击「更多信息」→「仍要运行」
4. 浏览器自动打开 `http://127.0.0.1:8912`（端口被占用会自动顺延）
5. 拖入视频 → 选格式 → 开始提取 → 下载音频

> 关闭窗口即停止服务；临时文件自动清理。

### 局域网模式（手机访问）

默认仅本机可访问。想让同一 WiFi 下的手机使用：

```bat
set AUDIO_EXTRACTOR_LAN=1
start.bat
```

启动后按窗口打印的局域网地址访问（手机浏览器打开即可 PWA 安装）。

## 系统要求 Requirements

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（64 位） |
| 依赖 | 无（全部内置） |
| 磁盘 | 解压后约 250 MB |
| 权限 | 无需管理员 |

> 不支持 Windows 7/8（Node 22 运行时最低要求 Win10）。

## 目录结构

```
audio-extractor/
├── start.bat          # 一键启动
├── node.exe           # 内置运行时 (Node 22)
├── ffmpeg.exe         # 内置转码引擎 (FFmpeg essentials build)
├── server.js          # 服务端源码
├── public/            # Web 界面 (HTML/CSS/JS + PWA)
├── node_modules/      # 运行依赖 (express, multer)
├── README.txt         # 本说明（zip 内简版）
└── THIRD-PARTY-NOTICES.txt   # 第三方许可声明
```

## 从源码运行 Run from source

```bash
npm install
node server.js
```

需要系统已有 Node.js ≥ 18 与 FFmpeg（或在项目目录放置 `ffmpeg.exe`，
亦可通过环境变量 `FFMPEG_PATH` 指定）。

## 打包发布 Build portable zip

仓库内 `tools/build.bat` 可将源码与便携材料组装成分发 zip：

```bat
:: 1) 从模板创建本机构建配置（已 gitignore，不会入库）：
::    copy tools\build.local.example.bat tools\build.local.bat
:: 2) 编辑 tools\build.local.bat 填入你本机 node.exe / ffmpeg.exe 路径
:: 3) 双击运行
tools\build.bat
```

产物：`dist/audio-extractor-vX.X.X-win-x64.zip` + 同名 `.sha256` 校验文件。

## 工作原理 How it works

视频是容器格式：画面与音频是两条独立流。FFmpeg 按需处理：

```bash
ffmpeg -i input.mp4 -vn -c:a copy output.m4a     # M4A：无损流拷贝，约10倍速
ffmpeg -i input.mp4 -vn -acodec libmp3lame -q:a 2 output.mp3   # MP3：重编码
```

## 安全说明 Security Notes

- 服务默认只监听 `127.0.0.1`，外部设备无法访问；局域网模式需显式开启
- 文件处理完成后临时副本自动删除
- 本工具不采集任何数据、不联网传输你的媒体文件

## License

本项目代码以 [MIT](LICENSE) 许可开源。
FFmpeg 属于第三方软件，遵循其原始许可（LGPL），见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。

## 反馈 Issues

遇到问题欢迎提 [Issue](../../issues)，请附上：系统版本、视频格式、终端窗口里的报错文字。
