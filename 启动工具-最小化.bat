@echo off
title 音频提取工具
cd /d "%~dp0"

:: 服务已在运行则直接打开浏览器
netstat -ano | findstr ":8912.*LISTENING" >nul 2>nul
if not errorlevel 1 goto open_browser

:: 最小化启动后台服务（任务栏一个小窗口；页面底部可点「退出服务」关闭）
start "音频提取工具服务" /min cmd /c "node server.js"

:wait
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8912/api/health' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
    set /a count+=1
    if %count% gtr 30 (
        echo [错误] 服务启动超时，请确认 Node.js 可用
        pause
        exit /b 1
    )
    goto wait
)

:open_browser
powershell -NoProfile -Command "Start-Process 'http://localhost:8912'"
echo [已启动] 音频提取工具已就绪，浏览器已打开
