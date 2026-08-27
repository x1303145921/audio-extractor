@echo off
chcp 65001 >nul
setlocal

:: ============================================================
::  音频提取器 - 便携版打包脚本
::  用法：双击运行，生成 dist\音频提取器_vX.X.zip
:: ============================================================

set "PROJECT=%~dp0"
set "DIST=%PROJECT%dist"
set "VERSION=1.1.0"
set "ZIPNAME=音频提取器_v%VERSION%.zip"

echo [打包] 项目目录: %PROJECT%
echo [打包] 输出目录: %DIST%

:: 清理旧产物
if exist "%DIST%" rd /s /q "%DIST%"
mkdir "%DIST%" >nul 2>&1

:: 复制项目核心文件（不复制 dev 文件）
xcopy "%PROJECT%server.js"     "%DIST%\" /Y /Q >nul
xcopy "%PROJECT%package.json"  "%DIST%\" /Y /Q >nul
xcopy "%PROJECT%public"        "%DIST%\public\" /E /Y /Q >nul

:: 复制 FFmpeg 便携版（可选：项目根目录放 ffmpeg-bin\ffmpeg.exe 时才打包）
if exist "%PROJECT%ffmpeg-bin\ffmpeg.exe" (
    xcopy "%PROJECT%ffmpeg-bin\ffmpeg.exe" "%DIST%\ffmpeg-bin\" /Y /Q >nul
) else (
    echo [提示] 未找到 ffmpeg-bin\\ffmpeg.exe，便携包将依赖目标机器的 FFmpeg
)

:: 复制启动脚本与开源文件
copy "%PROJECT%启动音频提取工具.bat" "%DIST%\" >nul
if exist "%PROJECT%start.bat" copy "%PROJECT%start.bat" "%DIST%\" >nul
if exist "%PROJECT%LICENSE" xcopy "%PROJECT%LICENSE" "%DIST%\" /Y /Q >nul
if exist "%PROJECT%README.md" xcopy "%PROJECT%README.md" "%DIST%\" /Y /Q >nul

echo [打包] 文件复制完成，开始压缩...

:: 用 7z 压缩（便携版自带 7z，或调用系统 PATH）
where 7z >nul 2>&1
if %errorlevel%==0 (
    7z a -tzip -mx9 "%PROJECT%%ZIPNAME%" "%DIST%\*" >nul
) else (
    powershell -Command "Compress-Archive -Path '%DIST%\*' -DestinationPath '%PROJECT%%ZIPNAME%' -CompressionLevel Optimal"
)

if exist "%PROJECT%%ZIPNAME%" (
    echo.
    echo ========================================
    echo  打包完成！
    echo  文件: %PROJECT%%ZIPNAME%
    echo  大小: 
    for %%F in ("%PROJECT%%ZIPNAME%") do echo    %%~zF 字节 （%%~zF / 1048576 MB）
    echo ========================================
    echo.
    echo 分发方式：把 zip 发给对方，解压后双击「启动音频提取工具.bat」
) else (
    echo [错误] 压缩失败，请检查 7z 或 PowerShell 是否可用
)

pause