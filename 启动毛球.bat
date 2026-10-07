@echo off
rem Maoqiu (MC Launcher) - double-click launcher
rem
rem Keep this file ASCII-only on purpose: cmd.exe reads batch files using the
rem system code page (GBK on a Chinese Windows), so UTF-8 Chinese text here
rem gets mangled and can break the whole line parse. All Chinese messages are
rem printed by Node instead (see scripts/start.js).
rem
rem chcp 65001 switches the console to UTF-8 so Node's Chinese output shows up
rem correctly.

chcp 65001 >nul
cd /d "%~dp0"
node scripts\start.js
echo.
pause
