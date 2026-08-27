@echo off
setlocal EnableDelayedExpansion
title 音频提取工具
cd /d "%~dp0"

:: Node.js: 优先同目录(便携包自带), 回退 PATH
set "NODE_BIN=node"
if exist "%~dp0node.exe" set "NODE_BIN=%~dp0node.exe"

"%NODE_BIN%" --version >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js, 请确认解压目录完整
    pause
    exit /b 1
)

:: 端口已被占用: 先探健康; 服务正常则直接开浏览器, 异常则清理残留进程后重启
netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    curl -s --noproxy "*" -m 3 http://localhost:8912/api/health >nul 2>nul
    if not errorlevel 1 goto open_browser
    echo [提示] 检测到残留服务异常, 正在清理并重启...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8912.*LISTENING"') do taskkill /F /PID %%p >nul 2>nul
    ping -n 2 127.0.0.1 >nul
)

:: 最小化启动后台服务(任务栏一个小窗口; 页面底部可点「退出服务」关闭)
start "音频提取工具服务" /min cmd /c ""%NODE_BIN%" server.js"

set /a count=0
:wait
ping -n 2 127.0.0.1 >nul
curl -s --noproxy "*" -m 3 http://localhost:8912/api/health >nul 2>nul
if errorlevel 1 (
    set /a count+=1
    if !count! gtr 30 (
        echo [错误] 服务启动超时, 请确认本目录未被移动或改名
        pause
        exit /b 1
    )
    goto wait
)

:open_browser
powershell -NoProfile -Command "Start-Process 'http://localhost:8912'"
echo [已启动] 音频提取工具已就绪, 浏览器已打开
