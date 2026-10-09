@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Агенти запущено: ринок, мережа, настрій, стейблкоїни, регулювання, новини. Зупинити: Ctrl+C.
python tools\run_agents.py --watch
pause
