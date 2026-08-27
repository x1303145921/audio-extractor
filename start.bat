@echo off
title Audio Extractor

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

if not exist "D:\Tools\ffmpeg\bin\ffmpeg.exe" (
    echo [ERROR] FFmpeg not found at D:\Tools\ffmpeg\bin\ffmpeg.exe
    pause
    exit /b 1
)

netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 (
    goto open_browser
)

start "" cmd /c "node server.js"

:wait
timeout /t 1 /nobreak >nul
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8912/api/health' -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto wait

:open_browser
powershell -Command "Start-Process 'http://localhost:8912'"

echo [OK] Audio Extractor is running at http://localhost:8912
echo Close this window to stop the service.