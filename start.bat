@echo off
setlocal

rem ChatGPT/Codex access token. Set your token here or define it before starting.
if "%CHATGPT_ACCESS_TOKEN%"=="" (
    set /p "CHATGPT_ACCESS_TOKEN=Enter ChatGPT/Codex access token: "
)

if "%CHATGPT_ACCESS_TOKEN%"=="" (
    echo CHATGPT_ACCESS_TOKEN is required.
    pause
    exit /b 1
)

set "CHATGPT_ACCESS_TOKEN=%CHATGPT_ACCESS_TOKEN%"

pnpm run server-chatgpt

pause
