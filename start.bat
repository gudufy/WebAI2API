@echo off
setlocal
cd /d "%~dp0"
title WebAI2API - ChatGPT Browser

rem ChatGPT browser mode does not require CHATGPT_ACCESS_TOKEN.
set "CHATGPT_CDP_URL=http://127.0.0.1:9222"
set "CHATGPT_PROFILE=%LOCALAPPDATA%\WebAI2API\ChatGPTProfile"

rem Locate Microsoft Edge.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
    echo [ERROR] Microsoft Edge was not found.
    echo Install Edge or edit start.bat to point EDGE to msedge.exe.
    pause
    exit /b 1
)

rem Check Node.js and pnpm.
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or is not on PATH.
    pause
    exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] pnpm is not installed. Run: npm install -g pnpm
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing project dependencies...
    call pnpm install
    if errorlevel 1 (
        echo [ERROR] pnpm install failed.
        pause
        exit /b 1
    )
)

rem Start a dedicated Edge profile with CDP enabled, preserving its login between runs.
if not exist "%CHATGPT_PROFILE%" mkdir "%CHATGPT_PROFILE%"
echo [INFO] ChatGPT browser profile: "%CHATGPT_PROFILE%"
echo [INFO] Starting Edge with remote debugging on port 9222...
start "WebAI2API ChatGPT Edge" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%CHATGPT_PROFILE%" https://chatgpt.com/

rem Wait up to 30 seconds for the CDP endpoint to become available.
echo [INFO] Waiting for Edge CDP...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='http://127.0.0.1:9222/json/version'; for($i=0;$i -lt 30;$i++){try{$r=Invoke-RestMethod -Uri $u -TimeoutSec 1; if($r.webSocketDebuggerUrl){exit 0}}catch{}; Start-Sleep -Seconds 1}; exit 1"
if errorlevel 1 (
    echo [ERROR] Edge CDP did not become available on port 9222.
    echo Close other Edge instances using this profile/port, then run start.bat again.
    pause
    exit /b 1
)

echo [INFO] Starting WebAI2API ChatGPT server...
echo [INFO] If ChatGPT asks you to log in, sign in in the Edge window and keep it open.
echo.
call pnpm run server-chatgpt

echo.
echo [INFO] WebAI2API server has stopped.
pause
