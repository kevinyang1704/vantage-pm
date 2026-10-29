@echo off
rem Vantage in your browser (local-only). Double-click to start; close this
rem window to stop. Needs Node.js 24 and access to the npm registry (or your
rem company's npm mirror). Opens http://127.0.0.1:5173
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install Node.js 24, then run this again. & pause & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node --version') do set NODE_MAJOR=%%v
if not "%NODE_MAJOR%"=="v24" (echo This needs Node.js 24; found & node --version & pause & exit /b 1)
if not exist node_modules\.package-lock.json (
  echo Installing dependencies ^(first run only^)...
  call npm ci --ignore-scripts --no-fund --no-audit || (echo npm install failed. If the npm registry is blocked, set your company mirror: npm config set registry ^<url^> & pause & exit /b 1)
)
echo Building and starting Vantage at http://127.0.0.1:5173 ...
call npm start
