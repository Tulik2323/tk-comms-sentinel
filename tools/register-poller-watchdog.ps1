# register-poller-watchdog.ps1 - registers the "NetMonitor Watchdog" scheduled task.
#
# Run once, as Administrator, on the monitoring server:
#   powershell -ExecutionPolicy Bypass -File tools\register-poller-watchdog.ps1
#
# The task runs backend\run-watchdog.cmd every 5 minutes as SYSTEM. The watchdog
# (backend\poller-watchdog.js) alerts by Telegram and e-mail when the poller has
# stopped (no heartbeat for 5 minutes), closes a poller process that is stuck so the
# "NetMonitor Poller" task can start a new one, and warns about low disk space.
# It does not depend on the web site or on the poller, so it alerts even when both
# are down. ASCII only on purpose (Windows PowerShell 5.1 reads scripts as ANSI).

param(
    [string]$BackendDir = 'C:\inetpub\wwwroot\tkcommssentinel\backend'
)

$ErrorActionPreference = 'Stop'
$taskName = 'NetMonitor Watchdog'
$cmd      = Join-Path $BackendDir 'run-watchdog.cmd'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run this script as Administrator.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $cmd)) {
    Write-Host "Not found: $cmd (deploy version 1.15.0 or later first)" -ForegroundColor Red
    exit 1
}

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory $BackendDir
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$userPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $userPrincipal `
    -Description 'TK Comms Sentinel: alerts when the poller stops, restarts a stuck poller, warns on low disk space.' | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Registered and started '$taskName' (every 5 minutes, SYSTEM)." -ForegroundColor Green
Write-Host "Log: $BackendDir\logs\watchdog.log"
