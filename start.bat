@echo off
chcp 65001 >nul
title 任务面板 · 本地服务
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe" set "NODE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe"

if not defined NODE (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)

"%NODE%" server.js --open
echo.
echo 服务已停止，按任意键关闭窗口。
pause >nul
