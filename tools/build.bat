@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

:: ============================================================
::  build portable distribution zip
::  The tool paths below are machine-specific. They live in
::  tools\build.local.bat (gitignored). Copy the template first:
::      copy tools\build.local.example.bat tools\build.local.bat
:: ============================================================
if not exist "%~dp0build.local.bat" (
  echo [ERROR] tools\build.local.bat not found.
  echo         Run: copy tools\build.local.example.bat tools\build.local.bat
  pause
  exit /b 1
)
call "%~dp0build.local.bat"

:: bump VERSION when releasing
set VERSION=0.1.1
set NAME=audio-extractor-v%VERSION%-win-x64
set OUT=dist\%NAME%

echo [build] assembling %OUT% ...
if exist dist rd /s /q dist
mkdir "%OUT%" || goto :fail

:: sources
copy server.js              "%OUT%\" >nul || goto :fail
copy package.json           "%OUT%\" >nul || goto :fail
xcopy public                "%OUT%\public\" /e /i /y >nul || goto :fail
copy start.bat              "%OUT%\start.bat" >nul || goto :fail
copy README.txt             "%OUT%\README.txt" >nul || goto :fail
copy THIRD-PARTY-NOTICES.txt "%OUT%\THIRD-PARTY-NOTICES.txt" >nul || goto :fail
copy LICENSE                "%OUT%\LICENSE" >nul || goto :fail
xcopy node_modules          "%OUT%\node_modules\" /e /i /y >nul || goto :fail

:: portable runtime (must exist)
if not exist "%NODE_EXE%"   ( echo [ERROR] NODE_EXE not found: %NODE_EXE% & goto :fail )
if not exist "%FFMPEG_EXE%" ( echo [ERROR] FFMPEG_EXE not found: %FFMPEG_EXE% & goto :fail )
copy /y "%NODE_EXE%"   "%OUT%\node.exe"   >nul || goto :fail
copy /y "%FFMPEG_EXE%" "%OUT%\ffmpeg.exe" >nul || goto :fail

:: starter for LAN mode convenience
> "%OUT%\lan.bat" echo @echo off
>>"%OUT%\lan.bat" echo set AUDIO_EXTRACTOR_LAN=1
>>"%OUT%\lan.bat" echo call "%%~dp0start.bat"

echo [build] creating zip ...
where 7z >nul 2>nul
if %errorlevel%==0 (
  7z a -tzip -mx9 "dist\%NAME%.zip" ".\dist\%NAME%\*" >nul || goto :fail
) else (
  powershell -NoProfile -Command "Compress-Archive -Path 'dist\%NAME%\*' -DestinationPath 'dist\%NAME%.zip' -CompressionLevel Optimal" || goto :fail
)

echo [build] writing sha256 ...
powershell -NoProfile -Command "(Get-FileHash 'dist\%NAME%.zip' -Algorithm SHA256).Hash.ToLower() + '  %NAME%.zip' | Set-Content -Encoding ascii 'dist\%NAME%.sha256'"

for %%F in ("dist\%NAME%.zip") do set ZSIZE=%%~zF
echo ================================================
echo  OK  dist\%NAME%.zip  (%ZSIZE% bytes)
echo ================================================
exit /b 0

:fail
echo [FATAL] build failed.
pause
exit /b 1