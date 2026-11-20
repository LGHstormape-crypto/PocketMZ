@echo off
chcp 65001 >nul
rem 命令行工具：python pocketmz-convert.py --help
where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw "%~dp0pocketmz-convert-gui.pyw" %*
) else (
    start "" python "%~dp0pocketmz-convert-gui.pyw" %*
)
