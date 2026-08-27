@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  音频提取工具 - 零依赖便携版打包脚本
::  用法：双击运行（或 build-portable.bat -y 免确认）
::  产出：dist-portable\audio-extractor-portable-v<版本>.zip
::  包内自带 node.exe + ffmpeg.exe + node_modules，解压即用
:: ============================================================

set "PROJECT=%~dp0"
set "OUTDIR=%PROJECT%dist-portable"
set "DIST=%OUTDIR%\pkg"

:: 版本号统一取自 package.json
for /f "delims=" %%V in ('node -e "console.log(require('./package.json').version)"') do set "VERSION=%%V"
if "%VERSION%"=="" ( echo [错误] 无法读取版本号，请确认已安装 Node.js & exit /b 1 )

set "ZIPNAME=audio-extractor-portable-v%VERSION%.zip"
set "ZIPFULL=%OUTDIR%\%ZIPNAME%"

echo [打包] 版本: %VERSION%
echo [打包] 输出: %ZIPFULL%

if exist "%DIST%" rd /s /q "%DIST%"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
mkdir "%DIST%"

:: ---- 核心源码与前端 ----
copy "%PROJECT%server.js"        "%DIST%\" >nul
copy "%PROJECT%package.json"     "%DIST%\" >nul
xcopy "%PROJECT%public"          "%DIST%\public\" /E /Y /Q >nul

:: ---- Node 运行时（取当前 node）----
for /f "delims=" %%N in ('node -e "console.log(process.execPath)"') do set "NODEEXE=%%N"
if exist "%NODEEXE%" (
  copy "%NODEEXE%" "%DIST%\node.exe" >nul
  echo [打包] node.exe 已内置
) else (
  echo [警告] 未找到 node.exe，便携包将依赖目标机器安装 Node.js
)

:: ---- node_modules（免安装依赖）----
if exist "%PROJECT%node_modules" (
  xcopy "%PROJECT%node_modules" "%DIST%\node_modules\" /E /Y /Q >nul
  echo [打包] node_modules 已内置
)

:: ---- FFmpeg：优先项目内 ffmpeg-bin，其次本机默认位置 ----
if exist "%PROJECT%ffmpeg-bin\ffmpeg.exe" (
  xcopy "%PROJECT%ffmpeg-bin\ffmpeg.exe" "%DIST%\ffmpeg-bin\" /Y /Q >nul
) else if exist "D:\Tools\ffmpeg\bin\ffmpeg.exe" (
  mkdir "%DIST%\ffmpeg-bin" >nul 2>&1
  copy "D:\Tools\ffmpeg\bin\ffmpeg.exe" "%DIST%\ffmpeg-bin\ffmpeg.exe" >nul
  echo [打包] ffmpeg.exe 已从本机默认位置内置
) else (
  echo [警告] 未找到 ffmpeg.exe，便携包将依赖目标机器的 FFmpeg
)

:: ---- 启动脚本与文档 ----
if exist "%PROJECT%启动工具-最小化.bat" copy "%PROJECT%启动工具-最小化.bat" "%DIST%\" >nul
if exist "%PROJECT%启动音频提取工具.bat" copy "%PROJECT%启动音频提取工具.bat" "%DIST%\" >nul
if exist "%PROJECT%start.bat" copy "%PROJECT%start.bat" "%DIST%\" >nul
if exist "%PROJECT%LICENSE" copy "%PROJECT%LICENSE" "%DIST%\" >nul
if exist "%PROJECT%README.md" copy "%PROJECT%README.md" "%DIST%\" >nul
if exist "%PROJECT%README.txt" copy "%PROJECT%README.txt" "%DIST%\" >nul
if exist "%PROJECT%THIRD-PARTY-NOTICES.txt" copy "%PROJECT%THIRD-PARTY-NOTICES.txt" "%DIST%\" >nul

echo [打包] 文件复制完成，开始压缩...

:: ---- 压缩：优先 7-Zip（桌面工具箱），否则 PowerShell ----
set "SZ=D:\Users\x1303\Desktop\工具箱\7-Zip\7z.exe"
if exist "%SZ%" (
  "%SZ%" a -tzip -mx9 "%ZIPFULL%" "%DIST%\*" >nul
) else (
  powershell -NoProfile -Command "Compress-Archive -Path '%DIST%\*' -DestinationPath '%ZIPFULL%' -CompressionLevel Optimal"
)

if exist "%ZIPFULL%" (
  for %%F in ("%ZIPFULL%") do set "ZSIZE=%%~zF"
  echo.
  echo ========================================
  echo  打包完成！
  echo  文件: %ZIPFULL%
  echo  大小: !ZSIZE! 字节
  echo ========================================
  echo  分发：把 zip 发给对方，解压后双击「启动工具-最小化.bat」即可使用
) else (
  echo [错误] 压缩失败，请检查 7-Zip 或 PowerShell 是否可用
)

if /i not "%~1"=="-y" pause
