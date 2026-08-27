@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem 检查必要文件
if not exist "node.exe" goto :missing
if not exist "启动工具-最小化.bat" goto :missing
if not exist "public\app-icon.ico" goto :missing

set "AE_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d '音频提取工具.lnk')); $s.TargetPath=(Join-Path $env:AE_DIR '启动工具-最小化.bat'); $s.WorkingDirectory=$env:AE_DIR; $s.IconLocation=(Join-Path $env:AE_DIR 'public\app-icon.ico')+',0'; $s.Description='音频提取工具 - 双击启动'; $s.Save()"
if errorlevel 1 goto :fail

echo.
echo  安装完成！桌面已出现「音频提取工具」图标，双击即可使用。
echo  提示：图标可随时删除，不影响程序本体。
pause
exit /b 0

:missing
echo  缺少必要文件，请确认本脚本位于解压目录内且文件完整。
pause
exit /b 1

:fail
echo  创建快捷方式失败，请重试；或右键「启动工具-最小化.bat」手动发送到桌面。
pause
exit /b 1
