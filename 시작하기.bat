@echo off
title Flower Workshop Manager
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from  https://nodejs.org
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)

echo Closing old version if running...
taskkill /f /im node.exe >nul 2>nul

if not exist "node_modules\bcryptjs" (
  echo Installing components... please wait.
  call npm install --no-audit --no-fund
)

start "" http://localhost:4000
node server.js
pause
