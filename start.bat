@echo off
setlocal
cd /d "%~dp0"

if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="CHATGPT_ACCESS_TOKEN" set "CHATGPT_ACCESS_TOKEN=%%B"
        if /i "%%A"=="CHATGPT_ACCOUNT_ID" set "CHATGPT_ACCOUNT_ID=%%B"
        if /i "%%A"=="CHATGPT_USER_AGENT" set "CHATGPT_USER_AGENT=%%B"
    )
)

if "%CHATGPT_ACCESS_TOKEN%"=="" (
    echo CHATGPT_ACCESS_TOKEN is not configured.
    echo Please copy .env.example to .env and set your ChatGPT/Codex access token.
    pause
    exit /b 1
)

pnpm run server-chatgpt

pause
