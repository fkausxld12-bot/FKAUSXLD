@echo off
title Flower Workshop Self Test
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from  https://nodejs.org
  echo.
  pause
  exit /b 1
)

node selftest.js
echo.
pause
