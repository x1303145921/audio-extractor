@echo off
chcp 65001 >nul
title 音频提取工具

cd /d "%~dp0"

:: 依赖检查
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)
if not exist "D:\Tools\ffmpeg\bin\ffmpeg.exe" (
    echo [错误] 未检测到 FFmpeg（D:\Tools\ffmpeg\bin\ffmpeg.exe）
    pause
    exit /b 1
)

:: 检查端口是否已被占用
netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [提示] 服务已在运行，正在打开浏览器...
    goto open_browser
)

:: 后台启动 node 服务
start "" cmd /c "node server.js"

:: 等待服务就绪（最多等 30 秒）
:wait
timeout /t 1 /nobreak >nul
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8912/api/health' -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
    set /a count+=1
    if %count% gtr 30 (
        echo [错误] 服务启动超时，请检查是否有错误提示
        pause
        exit /b 1
    )
    goto wait
)

:open_browser
:: 用 PowerShell 打开默认浏览器（比 start 更可靠）
powershell -Command "Start-Process 'http://localhost:8912'"

echo [已启动] 音频提取工具已就绪
echo 服务地址：http://localhost:8912
echo 关闭此窗口将停止服务