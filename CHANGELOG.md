# Changelog

本仓库遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.补丁`。

## [1.4.2] - 2026-08-29

### 修复
- 统一错误响应格式：所有失败响应（`/api/extract`、`/api/extract-from-path`、SSE）统一携带 `errorCode` 字段，前端可按码差异化展示。
- `runExtract` 失败时把 `errorCode` / `errorHint` 写入 job 对象，SSE 推送包含结构化错误信息。

### 优化
- SSE 推送增加 `errorCode` / `errorHint` 字段，前端错误展示更精准。

## [1.4.1] - 2026-08-29

### 修复
- FFmpeg 失败错误分类：服务端把 FFmpeg 失败按关键词映射为结构化错误码（ENCODER_MISSING / INVALID_INPUT / PERMISSION_DENIED / DISK_FULL 等），前端状态徽标悬浮显示具体失败原因。
- jobId 长度限制：上限 64 字符，防止批量高并发时产生极长 key。
- stderr 内存优化：按行消费，只保留最后 200 行，替代原截尾 256KB 方案。

### 优化
- SSE 断线重连：EventSource 断开后指数退避重连（3s → 30s 上限），进度条不再卡死。
- 前端失败状态展示：错误信息填充到状态徽标 title 属性，悬浮可见具体原因。

## [1.4.0] - 2026-08-29

### 新增
- 便携版 zip 内文件改为统一放在 `audio-extractor/` 子目录中：解压后只出现一个干净的文件夹，拖到任何位置都能直接用，不再平铺一堆文件。
- `build-portable.bat` 优化：自动排除自身、支持无 Node 时仅警告不中断、中文路径修复为系统编码（UTF-8 BOM），脚本整体更稳健。

### 变更
- 便携版使用方式更新：解压 zip → 进入 `audio-extractor/` 文件夹 → 双击「启动工具-最小化.bat」即可使用。
- 「安装到桌面.bat」仍然保留在 zip 内，有桌面图标需求的用户仍可使用。