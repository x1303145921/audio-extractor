# 参与贡献

感谢你愿意为这个项目花时间！在提交 Issue 或 PR 之前，请先花一分钟读一下这几条约定。

## 报告问题（Issue）

- 先搜索已有 Issue，避免重复提交。
- 描述问题时尽量包含：**复现步骤**、**期望行为**、**实际行为**、**运行环境**（Windows 版本 / 便携版还是源码运行 / 浏览器），如有报错截图或日志请一并附上。
- 问题模板见 [.github/ISSUE_TEMPLATE/bug_report.md](.github/ISSUE_TEMPLATE/bug_report.md)。

## 提交代码（Pull Request）

1. Fork 本仓库，从 `main` 分支切出新分支：`git checkout -b fix/xxx` 或 `feat/xxx`。
2. 保持改动聚焦：一个 PR 解决一个问题。
3. 代码风格与现有代码保持一致（本项目为无框架的原生 Node + 原生前端，不引入新依赖）。
4. 提交信息用简洁的中文描述，格式参考 `fix:` / `feat:` 前缀（见 CHANGELOG 归纳方式）。
5. 如果改动涉及用户可见行为，同步更新 README 与 CHANGELOG。
6. 提交后发起 PR，等待 review；合入前请确认本地 `node server.js` 能正常启动。

## 开发环境

```bash
git clone <本仓库地址>
cd audio-extractor
npm install
npm start          # 开发调试：http://localhost:8912
```

- 版本号只改 `package.json`（`version` 字段），服务端与打包脚本自动读取。
- 打包便携版：双击 `build-portable.bat`（需本机已有 node.exe 与 ffmpeg.exe）。
- 修改前端后建议清浏览器缓存或硬刷新（Ctrl+F5）验证。

## 行为准则

保持友善、就事论事。本项目是个人开源作品，维护精力有限，请多包涵。
