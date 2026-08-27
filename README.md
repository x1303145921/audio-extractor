# 音频提取工具 · Audio Extractor

从视频文件中提取音频的**纯本地** Web 工具。浏览器拖入视频 → FFmpeg 转码 → 直接下载音频，文件全程不离开你的电脑。

支持 **M4A / MP3 / WAV / FLAC / Opus** 五种格式，手机可通过局域网访问并以 PWA 形式安装使用。

## 特性

- :lock: **纯本地处理**：无任何云端依赖，隐私安全
- :iphone: **PWA 支持**：Android / iOS 添加到主屏幕后接近原生应用体验
- :globe_with_meridians: **局域网共享**：手机与电脑同 WiFi 即可直接访问
- :jigsaw: **分片上传**：大文件（最大 4GB）自动分片，避免手机浏览器单次上传失败
- :chart_with_upwards_trend: **实时进度**：转码百分比由服务端真实回传（SSE），不靠动画假装
- :stop_button: **任务可取消**：随时中止正在跑的转码，FFmpeg 进程即时停止
- :package: **多结果下载列表**：批量处理时每个成品单独下载，不再只剩最后一个
- :twisted_rightwards_arrows: **端口顺延**：默认端口被占用时自动向后换新端口启动
- :zap: **stream copy 加速**：M4A / Opus 走容器级拷贝，零重编码、约 10 倍速
- :broom: **自动清理**：过期临时文件与中断残留定期回收，不会蚕食磁盘
- :desktop_computer: **桌面级体验**：最小化静默启动，双击桌面图标即用；页面底部一键「退出服务」

## 快速开始

### 方式一：免安装便携版（推荐给非技术用户）

获取 `audio-extractor-portable-vX.zip`（见 [GitHub Releases](https://github.com/x1303145921/audio-extractor/releases)），解压后双击「**启动工具-最小化.bat**」即可：服务在任务栏最小化窗口后台运行，浏览器自动打开（推荐）；或双击「启动音频提取工具.bat」使用带控制台窗口的经典方式。

包内自带 Node 运行时与 FFmpeg，**无需安装任何东西**，Windows 10/11 64 位开箱即用；首次运行如遇 SmartScreen 提示，点「更多信息 → 仍要运行」。用完在页面底部点「退出服务」即可关闭后台服务，下次双击再次启动。

> **国内网络下载加速**：把下面链接开头的 `https://github.com/` 换成 `https://ghfast.top/https://github.com/` 即可走镜像加速，例如：
> `https://ghfast.top/https://github.com/x1303145921/audio-extractor/releases/latest`

自行打包便携版（需本机已有 node.exe 与 ffmpeg.exe）：直接双击项目根目录的 `build-portable.bat` 即可，版本号自动取自 package.json，产物输出到 `dist-portable\`。

### 方式二：源码运行

#### 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 推荐 LTS |
| FFmpeg | 任意近期版本 | 三种方式任选其一（见下方「FFmpeg 查找规则」） |

#### 安装与运行

```bash
git clone <本仓库地址>
cd audio-extractor
npm install
npm start          # 或 node server.js
```

启动后：

- 本机访问：<http://localhost:8912>
- 局域网访问：<http://你的IP:8912>（启动时会打印）

双击 `start.bat`（英文环境）、`启动音频提取工具.bat`（中文环境）或 `启动工具-最小化.bat`（最小化静默启动）可自动完成上述过程并打开浏览器。

#### FFmpeg 查找规则

服务端按以下顺序自动探测，找到即用：

1. 环境变量 `FFMPEG_PATH` 指向的 ffmpeg 可执行文件
2. 系统 `PATH` 中的 `ffmpeg`
3. 随包自带的 `ffmpeg-bin\ffmpeg.exe`（便携版即此方式）
4. 默认路径 `D:\Tools\ffmpeg\bin\ffmpeg.exe`（Windows 常见位置示例）

都找不到时服务会正常启动，但提取请求会返回明确报错；也可用

```bat
set FFMPEG_PATH=C:\path\to\ffmpeg.exe
node server.js
```

指定位置。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8912` | HTTP 监听端口（被占用时自动 +1 顺延，最多尝试 10 个） |
| `BIND` | `0.0.0.0` | 监听地址；设为 `127.0.0.1` 可限制仅本机访问（更安全） |
| `FFMPEG_PATH` | （自动探测） | 手动指定 ffmpeg 路径 |
| `MAX_EXTRACT_JOBS` | `2` | 同时转码的任务数上限，其余排队 |

## 输出格式

| 格式 | 编码器 | 特点 | 适用场景 |
|---|---|---|---|
| M4A | AAC (copy) | 体积小、兼容好、零重编 | 一般用途，**推荐** |
| MP3 | libmp3lame | 最通用 | 需要最大兼容性 |
| WAV | PCM | 无损、体积大 | 专业音频处理 |
| FLAC | FLAC | 无损、体积中等 | 高质量归档 |
| Opus | libopus (copy) | 压缩率最高、零重编 | 互联网传输、低带宽 |

## 工作原理

视频是容器格式，画面和音频是两条独立流。FFmpeg 一行命令即可剥离画面流、保留并转换音频流：

```
视频文件 → ffmpeg -vn → 指定编码器（或 -c:a copy）→ 音频文件
```

大文件（>50MB）时前端自动分片上传，服务端流式合并后再交给 FFmpeg，全程内存占用恒定。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/extract` | 小文件一步上传+提取（multipart） |
| POST | `/api/upload-chunk` | 分片上传单个分片 |
| POST | `/api/finalize-upload` | 结束上传并流式合并 |
| GET  | `/api/upload-status` | 查询分片接收进度 |
| POST | `/api/extract-from-path` | 对服务端已有文件执行提取 |
| GET  | `/api/progress/:jobId` | SSE 实时转码进度 |
| POST | `/api/cancel/:jobId` | 取消进行中的转码任务 |
| GET  | `/api/download?file=&name=` | 下载成品（`name` 指定下载文件名，中文自动编码） |
| GET  | `/api/health` | 健康检查（含版本与 FFmpeg 解析结果） |
| GET/POST | `/api/quit` | 退出服务（仅允许本机调用，配合静默启动器使用） |

## :warning: 安全提示

本工具面向个人/局域网使用，**没有任何鉴权机制**，请勿直接暴露到公网。如需公网使用请自行加反向代理认证或防火墙规则。

## License

[MIT](./LICENSE)
