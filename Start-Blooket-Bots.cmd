@echo off
setlocal
cd /d "%~dp0"
title Seuss Blooket bot service
where node >/dev/null 2>/dev/null
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting the Blooket bot service. Keep this window open while the bots run.
echo.
node scripts/bots-serve.mjs
echo.
echo The bot service stopped.
pause
