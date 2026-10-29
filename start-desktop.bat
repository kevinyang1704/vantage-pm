@echo off
rem Start the Vantage desktop app (after setup-desktop.bat has run once).
cd /d "%~dp0"
call npm run tauri:dev
