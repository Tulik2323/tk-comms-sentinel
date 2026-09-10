<#
.SYNOPSIS
  Register (or reconfigure) the TK Comms Sentinel Windows services via NSSM:
  the Express web backend (server.js) and the SNMP poller (poller-service.js).

.DESCRIPTION
  Both run as independent Windows services under the portable Node runtime.
  The web service and the poller are deliberately separate processes: the
  poller must keep its polling loop running uninterrupted, which is why it was
  moved out of IIS in the first place.

  Idempotent: if a service already exists it is reconfigured in place rather
  than reinstalled. Services are set to auto-start and to restart on crash.
  Stop is delivered as a console Ctrl-C so the app's SIGINT/SIGTERM handlers
  close the database cleanly.

  Must run elevated (Administrator).

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $NssmExe           = '',
  [string] $NodeExe           = '',
  [string] $BackendDir        = '',
  [string] $DataDir           = '',
  [string] $WebServiceName    = 'TKCommsSentinel',
  [string] $PollerServiceName = 'TKCommsSentinelPoller',
  [switch] $Start
)

$ErrorActionPreference = 'Stop'

# Fill defaults that depend on InstallRoot.
if (-not $NssmExe)    { $NssmExe    = Join-Path $InstallRoot 'tools\nssm.exe' }
if (-not $NodeExe)    { $NodeExe    = Join-Path $InstallRoot 'node\node.exe' }
if (-not $BackendDir) { $BackendDir = Join-Path $InstallRoot 'backend' }
if (-not $DataDir)    { $DataDir    = Join-Path $InstallRoot 'data' }

$logDir = Join-Path $DataDir 'logs'

function Assert-Path([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$What not found: $Path"
  }
}

Assert-Path $NssmExe    'nssm.exe'
Assert-Path $NodeExe    'node.exe'
Assert-Path $BackendDir 'backend directory'
Assert-Path (Join-Path $BackendDir 'server.js')         'server.js'
Assert-Path (Join-Path $BackendDir 'poller-service.js') 'poller-service.js'

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Invoke-Nssm {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)
  & $NssmExe @Args | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "nssm failed (exit $LASTEXITCODE): nssm $($Args -join ' ')"
  }
}

function Set-NssmService {
  param(
    [string] $Name,
    [string] $Script,
    [string] $DisplayName,
    [string] $Description
  )

  $exists = [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue)
  if ($exists) {
    Write-Host "[svc] '$Name' exists - reconfiguring."
  } else {
    Write-Host "[svc] Installing '$Name'."
    Invoke-Nssm install $Name $NodeExe $Script
  }

  Invoke-Nssm set $Name Application        $NodeExe
  Invoke-Nssm set $Name AppParameters      $Script
  Invoke-Nssm set $Name AppDirectory       $BackendDir
  Invoke-Nssm set $Name DisplayName        $DisplayName
  Invoke-Nssm set $Name Description        $Description
  Invoke-Nssm set $Name Start              SERVICE_AUTO_START

  # Graceful stop: send Ctrl-C and give the process 15s to close the DB.
  Invoke-Nssm set $Name AppStopMethodConsole 15000

  # Restart on unexpected exit, throttled so a crash loop does not spin.
  Invoke-Nssm set $Name AppExit    Default  Restart
  Invoke-Nssm set $Name AppThrottle 5000

  # Rotating stdout/stderr logs in the data directory.
  Invoke-Nssm set $Name AppStdout      (Join-Path $logDir "$Name.out.log")
  Invoke-Nssm set $Name AppStderr      (Join-Path $logDir "$Name.err.log")
  Invoke-Nssm set $Name AppRotateFiles 1
  Invoke-Nssm set $Name AppRotateOnline 1
  Invoke-Nssm set $Name AppRotateBytes 10485760

  Write-Host "[svc] '$Name' configured."
}

Write-Host "InstallRoot : $InstallRoot"
Write-Host "NodeExe     : $NodeExe"
Write-Host "BackendDir  : $BackendDir"
Write-Host "DataDir     : $DataDir"
Write-Host ""

Set-NssmService -Name $WebServiceName -Script 'server.js' `
  -DisplayName 'TK Comms Sentinel (Web)' `
  -Description 'TK Comms Sentinel web backend and UI (HTTPS).'

Set-NssmService -Name $PollerServiceName -Script 'poller-service.js' `
  -DisplayName 'TK Comms Sentinel (Poller)' `
  -Description 'TK Comms Sentinel SNMP polling service.'

if ($Start) {
  Write-Host ""
  Write-Host "[svc] Starting services..."
  Start-Service -Name $WebServiceName
  Start-Service -Name $PollerServiceName
  Get-Service -Name $WebServiceName, $PollerServiceName | Format-Table Name, Status -AutoSize
} else {
  Write-Host ""
  Write-Host "[svc] Registered. Start with:"
  Write-Host "      Start-Service $WebServiceName, $PollerServiceName"
}
