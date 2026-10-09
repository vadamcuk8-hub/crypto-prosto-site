@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Локальні дані пишуться в окрему папку data-local (її немає в репозиторії), щоб не плутатись із даними бота на GitHub
set CRYPTO_DATA_DIR=%~dp0data-local
if not exist "%CRYPTO_DATA_DIR%" mkdir "%CRYPTO_DATA_DIR%"
echo Агенти запущено, дані пишуться в папку data-local. Зупинити: Ctrl+C.
python tools\run_agents.py --watch
pause
