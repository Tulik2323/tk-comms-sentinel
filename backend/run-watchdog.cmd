@echo off
REM run-watchdog.cmd - wrapper for poller-watchdog.js, launched every 5 minutes by
REM the "NetMonitor Watchdog" scheduled task (tools\register-poller-watchdog.ps1).
REM ASCII only on purpose: cmd.exe does not parse UTF-8 batch files.
REM If the log cannot be written (disk full) the watchdog still runs: output is dropped.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
"C:\Program Files\nodejs\node.exe" "%~dp0poller-watchdog.js" >> "logs\watchdog.log" 2>&1
if errorlevel 1 "C:\Program Files\nodejs\node.exe" "%~dp0poller-watchdog.js" > nul 2>&1
exit /b 0
