@echo off
title Audio Extractor
cd /d "%~dp0"

:: Node.js: prefer bundled (portable package), fallback to PATH
set "NODE_BIN=node"
if exist "%~dp0node.exe" set "NODE_BIN=%~dp0node.exe"

"%NODE_BIN%" --version >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

:: FFmpeg is auto-resolved by the server (FFMPEG_PATH -> PATH -> default location)

netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    goto open_browser
)

start "" cmd /c ""%NODE_BIN%" server.js"

:wait
timeout /t 1 /nobreak >nul
curl -s --noproxy "*" -m 3 http://localhost:8912/api/health >nul 2>nul
if errorlevel 1 goto wait

:open_browser
powershell -Command "Start-Process 'http://localhost:8912'"

echo [OK] Audio Extractor is running at http://localhost:8912
echo Close this window to stop the service.
