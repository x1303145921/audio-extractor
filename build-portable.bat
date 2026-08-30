@echo off
setlocal enabledelayedExpansion

set "PROJECT=%~dp0"
set "OUTDIR=%PROJECT%dist-portable"
set "DIST=%OUTDIR%\pkg\audio-extractor"

for /f "delims=" %%V in ('node -e "console.log(require('./package.json').version)"') do set "VERSION=%%V"
if "%VERSION%"=="" ( echo [error] cannot read version & exit /b 1 )

set "ZIPNAME=audio-extractor-portable-v%VERSION%.zip"
set "ZIPFULL=%OUTDIR%\%ZIPNAME%"

echo [build] version: %VERSION%
echo [build] output: %ZIPFULL%

if exist "%DIST%" rd /s /q "%DIST%"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
mkdir "%DIST%"

copy "%PROJECT%server.js" "%DIST%\" >nul
copy "%PROJECT%package.json" "%DIST%\" >nul
xcopy "%PROJECT%public" "%DIST%\public\" /E /Y /Q >nul

for /f "delims=" %%N in ('node -e "console.log(process.execPath)"') do set "NODEEXE=%%N"
if exist "%NODEEXE%" (
  copy "%NODEEXE%" "%DIST%\node.exe" >nul
  echo [build] node.exe bundled
)

if exist "%PROJECT%node_modules" (
  xcopy "%PROJECT%node_modules" "%DIST%\node_modules\" /E /Y /Q >nul
  echo [build] node_modules bundled
)

if exist "%PROJECT%ffmpeg-bin\ffmpeg.exe" (
  xcopy "%PROJECT%ffmpeg-bin\ffmpeg.exe" "%DIST%\ffmpeg-bin\" /Y /Q >nul
) else if exist "D:\Tools\ffmpeg\bin\ffmpeg.exe" (
  mkdir "%DIST%\ffmpeg-bin" >nul 2^>^&1
  copy "D:\Tools\ffmpeg\bin\ffmpeg.exe" "%DIST%\ffmpeg-bin\ffmpeg.exe" >nul
  echo [build] ffmpeg.exe bundled
)

for %%F in ("%PROJECT%*.bat") do (
  if /I not "%%~nxF"=="build-portable.bat" copy "%%F" "%DIST%\" >nul
)

for %%F in ("%PROJECT%*.md") do copy "%%F" "%DIST%\" >nul
for %%F in ("%PROJECT%*.txt") do copy "%%F" "%DIST%\" >nul
copy "%PROJECT%LICENSE" "%DIST%\" >nul

if exist "%ZIPFULL%" del /q "%ZIPFULL%"
echo [build] compressing...

rem 压缩：优先 7z（PATH 或常见安装位置），否则回退 PowerShell Compress-Archive
set "SZ="
where 7z.exe >nul 2>nul && set "SZ=7z.exe"
if not defined SZ if exist "%ProgramFiles%\7-Zip\7z.exe" set "SZ=%ProgramFiles%\7-Zip\7z.exe"
if not defined SZ if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set "SZ=%ProgramFiles(x86)%\7-Zip\7z.exe"
if defined SZ (
  "%SZ%" a -tzip -mx9 "%ZIPFULL%" "%DIST%" >nul
) else (
  powershell -NoProfile -Command "Compress-Archive -Path '%DIST%' -DestinationPath '%ZIPFULL%' -CompressionLevel Optimal -Force"
)

if exist "%ZIPFULL%" (
  for %%F in ("%ZIPFULL%") do set "ZSIZE=%%~zF"
  echo.
  echo =======================================
  echo   done: %ZIPFULL%
  echo   size: !ZSIZE! bytes
  echo =======================================
) else (
  echo [error] build failed
)

if /I not "%~1"=="-y" pause