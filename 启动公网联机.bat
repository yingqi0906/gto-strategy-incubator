@echo off
chcp 65001 >nul
title GTO Poker Public Server
cd /d "%~dp0"

set "NODE_EXE=C:\Users\A\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" tunnel-host.js

echo.
pause
