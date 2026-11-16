@echo off
title Leftoff
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Leftoff needs Node.js. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting Leftoff. Keep this window open while you use it. Close it to stop.
node bin\leftoff.js
pause
