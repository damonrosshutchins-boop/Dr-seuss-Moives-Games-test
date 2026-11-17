@echo off
cd /d "%~dp0"
title Seuss Blooket bot service
echo Starting the Blooket bot service. Keep this window open while the bots run.
echo.
node scripts/bots-serve.mjs
echo.
echo The bot service stopped.
pause
