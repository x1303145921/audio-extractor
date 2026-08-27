# make-portable.ps1 - Build zero-dependency portable package
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1
# Output: dist-portable\<zip>. Requires local node.exe + ffmpeg.exe sources below.

$ErrorActionPreference = 'Stop'

$Project = Split-Path -Parent $PSScriptRoot    # repo root (parent of tools/)
$Version = '1.2.0'
$DistDir = Join-Path $Project 'dist-portable'
$StageName = "audio-extractor-portable-v$Version"
$Stage = Join-Path $DistDir $StageName

# --- binary sources (adjust here if your local install differs) ---
$NodeSrc = 'D:\nodejs\node.exe'
$FfmpegSrc = 'D:\Tools\ffmpeg\bin\ffmpeg.exe'
foreach ($src in @($NodeSrc, $FfmpegSrc)) {
    if (-not (Test-Path $src)) { Write-Error "Source binary missing: $src"; exit 1 }
}

Write-Host "[1/6] Preparing staging directory ..."
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'ffmpeg-bin') | Out-Null

Write-Host "[2/6] Copying application core ..."
Copy-Item (Join-Path $Project 'server.js')   $Stage
Copy-Item (Join-Path $Project 'package.json') $Stage
Copy-Item (Join-Path $Project 'LICENSE')     $Stage
Copy-Item (Join-Path $Project 'public')      (Join-Path $Stage 'public') -Recurse

Write-Host "[3/6] Copying node_modules (express + multer) ..."
Copy-Item (Join-Path $Project 'node_modules') (Join-Path $Stage 'node_modules') -Recurse

Write-Host "[4/6] Bundling runtime binaries (node + ffmpeg) ..."
Copy-Item $NodeSrc   (Join-Path $Stage 'node.exe')
Copy-Item $FfmpegSrc (Join-Path $Stage 'ffmpeg-bin\ffmpeg.exe')

Write-Host "[5/6] Generating launcher & readme ..."

$launchBat = @"
@echo off
chcp 65001 >nul
title Audio Extractor (Portable)

cd /d "%~dp0"

:: bundled FFmpeg (no system install needed)
set "FFMPEG_PATH=%~dp0ffmpeg-bin\ffmpeg.exe"

:: let Windows find node.exe beside this script too
set "PATH=%~dp0;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node.exe not found next to this script.
    pause
    exit /b 1
)

:: already running?
netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [i] Service already running, opening browser...
    goto open_browser
)

echo [i] Starting service (window minimizes itself)...
start "" /min cmd /c "node server.js"

:wait
timeout /t 1 /nobreak >nul
powershell -Command "try { `$r = Invoke-WebRequest -Uri 'http://127.0.0.1:8912/api/health' -UseBasicParsing -TimeoutSec 3; if (`$r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto wait

:open_browser
start "" "http://localhost:8912"
echo [OK] Audio Extractor running. Check the minimized window for LAN addresses.
echo Close that window to stop the service.
timeout /t 4 /nobreak >nul
"@

$readmeTxt = @"
==============================================
 音频提取器 audio-extractor - 便携版 v$Version
==============================================

【这是什么】
  从视频里提取音频的小工具（M4A / MP3 / WAV / FLAC / Opus）。
  完全离线运行：文件不出你的电脑，不联网、无广告。

【怎么用】
  1. 解压本压缩包到任意文件夹（路径建议不含特殊字符）
  2. 双击「启动音频提取工具.bat」
     （首次运行如遇 SmartScreen 蓝色提示：点「更多信息」→「仍要运行」）
  3. 浏览器会自动打开 http://localhost:8912
  4. 拖入视频 -> 选格式 -> 开始提取 -> 点下载
  5. 用完关掉最小化的黑色窗口即退出

【需要安装什么吗】
  不需要。本包自带 Node 运行时与 FFmpeg，
  Windows 10 / 11（64 位）开箱即用，无需管理员权限。
  如果电脑上已装过这些软件也无妨，优先使用包内自带版本。

【手机访问（可选）】
  手机连上和电脑相同的 WiFi，用黑色窗口里打印的
  「局域网」地址打开即可（形如 http://192.168.x.x:8912）。

【常见问题】
  Q: 双击后一闪而过？
  A: 别解压在系统保护目录（如 C:\Program Files），换到普通文件夹再试。
  Q: 提示端口被占用？
  A: 服务会自动从 8912 向后顺延空余端口，以窗口显示的地址为准。
  Q: 想只给自己用（禁止局域网其他设备访问）？
  A: 高级用法：cmd 里执行  set BIND=127.0.0.1 && node server.js

【目录结构】
  node.exe                 Node 运行时（自带）
  ffmpeg-bin\ffmpeg.exe    转码引擎（自带）
  server.js                服务端程序
  public\                  网页界面
  node_modules\            运行依赖

【开源与许可】
  本工具源码以 MIT 许可发布；
  FFmpeg 为第三方软件（GPL 构建，独立进程调用），
  参见项目仓库 THIRD-PARTY-NOTICES.txt 与 LICENSE。

【项目主页】 https://github.com/x1303145921/audio-extractor
"@

[System.IO.File]::WriteAllText((Join-Path $Stage '启动音频提取工具.bat'), $launchBat, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $Stage '使用说明.txt'), $readmeTxt, [System.Text.UTF8Encoding]::new($false))

Write-Host "[6/6] Compressing zip (this may take a minute) ..."
$ZipPath = Join-Path $DistDir ("$StageName.zip")
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
$SevenZip = 'D:\Users\x1303\Desktop\工具箱\7-Zip\7z.exe'
if (Test-Path $SevenZip) {
    & $SevenZip a -tzip -mx7 $ZipPath (Join-Path $Stage '*') | Out-Null
} else {
    Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $ZipPath -CompressionLevel Optimal
}
if (-not (Test-Path $ZipPath)) { Write-Error 'Zip creation failed'; exit 1 }

$zipMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "DONE => $ZipPath ($zipMB MB)"
