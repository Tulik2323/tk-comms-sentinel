@echo off
REM run-poller.cmd - wrapper for poller-service.js, launched by the
REM "NetMonitor Poller" scheduled task.
REM
REM Purpose: pin the working directory and capture stdout/stderr to a log.
REM ASCII only on purpose: cmd.exe does not parse UTF-8 batch files, and
REM non-ASCII characters corrupt the parsing of surrounding lines.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
echo [%DATE% %TIME%] --- poller service starting --- >> "logs\poller.log"
"C:\Program Files\nodejs\node.exe" "%~dp0poller-service.js" >> "logs\poller.log" 2>&1
echo [%DATE% %TIME%] --- poller service exited with %ERRORLEVEL% --- >> "logs\poller.log"
exit /b %ERRORLEVEL%
