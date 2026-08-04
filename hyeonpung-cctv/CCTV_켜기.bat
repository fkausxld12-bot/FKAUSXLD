@echo off
title Hyeonpung Farm CCTV Gateway
cd /d "%~dp0"
chcp 65001 >nul

if not exist "go2rtc.exe" (
  echo.
  echo  [1/2] go2rtc.exe not found in this folder.
  echo        Download "go2rtc_win64.zip", unzip it, and put go2rtc.exe here.
  echo        Opening the download page now...
  echo.
  start "" https://github.com/AlexxIT/go2rtc/releases/latest
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  if not exist "ffmpeg.exe" (
    echo.
    echo  [2/2] ffmpeg not found.
    echo        H.265 cameras need it to be converted for phones.
    echo        Put ffmpeg.exe in this folder, then run this file again.
    echo        Download: https://www.gyan.dev/ffmpeg/builds/
    echo.
    start "" https://www.gyan.dev/ffmpeg/builds/
    pause
    exit /b 1
  )
)

findstr /c:":PASSWORD@" go2rtc.yaml >nul 2>nul
if not errorlevel 1 (
  echo.
  echo  go2rtc.yaml still has the word PASSWORD in it.
  echo  Open go2rtc.yaml and replace PASSWORD with the real NVR password.
  echo.
  pause
  exit /b 1
)

echo.
echo  Hyeonpung Farm CCTV gateway is starting.
echo  Keep this window open. Closing it turns the CCTV page off.
echo.
echo  Farm phone page : http://eemi124.iptime.org:1984/
echo  This PC         : http://localhost:1984/
echo.

start "" http://localhost:1984/
go2rtc.exe -config go2rtc.yaml
pause
