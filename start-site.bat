@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Сайт для перегляду на комп'ютері: дані беруться з папки data-local (її наповнює start-agents.bat)
set CRYPTO_DATA_DIR=%~dp0data-local
if not exist "%CRYPTO_DATA_DIR%" mkdir "%CRYPTO_DATA_DIR%"
start "" http://localhost:8001/index.html
python tools\dev_server.py 8001
pause
