@echo off
rem Vantage desktop app: install what's missing, then build and start it.
rem Double-click, or run from a terminal. Options (passed through):
rem   -NoInstall       only check prerequisites, install nothing
rem   -NoLaunch        set up but don't start the app
rem   -WingetSource X  install from your company's winget source X
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup-desktop.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup stopped. Read the message above, fix it, then run setup-desktop.bat again.
  pause
  exit /b 1
)
