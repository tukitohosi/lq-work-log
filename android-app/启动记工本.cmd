@echo off
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Cannot open the application folder.
  pause
  exit /b 1
)

title Local Work Record

where.exe node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 20 or newer, then try again.
  pause
  popd
  exit /b 1
)

if not exist "dist\index.html" (
  echo [ERROR] The built web files are missing.
  echo Run npm install and npm run build in this folder first.
  pause
  popd
  exit /b 1
)

if "%JIGONGBEN_NO_OPEN%"=="1" (
  node.exe "server\index.mjs"
) else (
  node.exe "server\index.mjs" --open
)
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The local service stopped with exit code %EXIT_CODE%.
  pause
)

popd
endlocal & exit /b %EXIT_CODE%
