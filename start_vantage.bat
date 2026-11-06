@echo off
setlocal
cd /d "%~dp0"
rem Extracted portable package: launch the included runtime and app.
if exist "%~dp0runtime\node.exe" if exist "%~dp0app\index.html" (
  "%~dp0runtime\node.exe" "%~dp0serve-portable.mjs"
  if errorlevel 1 pause
  exit /b
)
rem Source checkout: launch the previously generated portable build.
if exist "%~dp0release\vantage-pm-portable\runtime\node.exe" if exist "%~dp0release\vantage-pm-portable\app\index.html" (
  "%~dp0release\vantage-pm-portable\runtime\node.exe" "%~dp0release\vantage-pm-portable\serve-portable.mjs"
  if errorlevel 1 pause
  exit /b
)
echo No complete portable build was found.
echo In a source checkout, run npm run package:portable once, then launch this file again.
echo If you downloaded the portable ZIP, extract the entire ZIP before launching.
pause
exit /b 1
