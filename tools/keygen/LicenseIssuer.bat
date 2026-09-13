@echo off
REM TK Comms Sentinel -- License Issuer launcher
REM Double-click this file to open the license issuer GUI.
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0LicenseIssuer.ps1"
