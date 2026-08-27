@echo off
setlocal
title audio-extractor
cd /d "%~dp0"

if not exist "node.exe" (
  echo [ERROR] node.exe not found next to start.bat.
  echo         Please keep all files together as extracted from the zip.
  pause & exit /b 1
)
if not exist "ffmpeg.exe" (
  echo [ERROR] ffmpeg.exe not found next to start.bat.
  echo         Please keep all files together as extracted from the zip.
  pause & exit /b 1
)

"%~dp0node.exe" "%~dp0server.js"

echo.
echo [i] Service stopped.
pause