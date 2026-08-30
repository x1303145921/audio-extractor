@echo off
chcp 936 >nul
title 下载音频提取工具 - 最新版
cd /d "%~dp0"

rem ============================================
rem 发布新版本时，请同步更新下面的版本号(VER)！
rem 同时更新 build-portable.bat 打包产物内的同名文件
rem ============================================
set "VER=1.6.3"
set "FILE=audio-extractor-portable-v%VER%.zip"
set "GHURL=https://github.com/x1303145921/audio-extractor/releases/download/v%VER%/%FILE%"

echo ============================================
echo   音频提取工具 便携版 v%VER% 下载器
echo ============================================
echo 目标文件: %FILE% （约 86 MB）
echo.

echo [1/3] 正在从镜像1（ghfast.top）下载...
curl.exe -f -L --ssl-no-revoke --connect-timeout 10 --max-time 600 -o "%FILE%" "https://ghfast.top/%GHURL%"
if not exist "%FILE%" (
    echo [2/3] 镜像1不可用，改用镜像2（gh-proxy.com）...
    curl.exe -f -L --ssl-no-revoke --connect-timeout 10 --max-time 600 -o "%FILE%" "https://gh-proxy.com/%GHURL%"
)
if not exist "%FILE%" (
    echo [3/3] 镜像2也不可用，尝试直连 GitHub（网络好或开加速器时可用）...
    curl.exe -f -L --ssl-no-revoke --connect-timeout 10 --max-time 600 -o "%FILE%" "%GHURL%"
)
if not exist "%FILE%" (
    echo.
    echo [错误] 下载失败，请检查网络后重试；
    echo        或手动打开 Releases 页面下载：
    echo        https://github.com/x1303145921/audio-extractor/releases/latest
    pause
    exit /b 1
)

for %%F in ("%FILE%") do (
    echo.
    echo 下载完成: %FILE%  （%%~zF 字节）
)
echo.
echo 下一步：右键压缩包 →「全部解压缩」→ 双击「安装到桌面.bat」
pause
