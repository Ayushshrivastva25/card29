@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules\express (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and Node.js/npm installation.
    pause
    exit /b 1
  )
)
echo Starting Card29. Keep this window open while you play.
echo Open http://localhost:3000 in your browser.
call npm start
pause
