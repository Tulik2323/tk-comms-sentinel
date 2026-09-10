@echo off
REM run-blackout-probe.cmd - internet blackout probe for TK Comms Sentinel
REM ASCII only on purpose: cmd.exe does not parse UTF-8 batch files and
REM non-ASCII characters corrupt the surrounding lines.
setlocal
cd /d "%~dp0"
title TK Sentinel - Blackout Probe

echo.
echo  ============================================================
echo   TK Comms Sentinel - Internet Blackout Probe
echo  ============================================================
echo.
echo   Log file: %~dp0logs\blackout-probe.log
echo   Keep this window open for the whole test.
echo   Press Ctrl+C to stop.
echo.

"C:\Program Files\nodejs\node.exe" "%~dp0scripts\blackout-probe.js" 15

echo.
echo  Probe stopped.
pause
