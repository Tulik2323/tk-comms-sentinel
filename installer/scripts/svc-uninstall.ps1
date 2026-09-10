<#
.SYNOPSIS
  Stop and remove the TK Comms Sentinel Windows services (web + poller).

.DESCRIPTION
  Idempotent: services that do not exist are skipped. Data (database, certs,
  configuration) is never touched. Must run elevated (Administrator).

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $NssmExe           = '',
  [string] $WebServiceName    = 'TKCommsSentinel',
  [string] $PollerServiceName = 'TKCommsSentinelPoller'
)

$ErrorActionPreference = 'Stop'
if (-not $NssmExe) { $NssmExe = Join-Path $InstallRoot 'tools\nssm.exe' }

function Remove-NssmService {
  param([string] $Name)

  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host "[svc] '$Name' not present - skipping."
    return
  }

  if ($svc.Status -ne 'Stopped') {
    Write-Host "[svc] Stopping '$Name'..."
    if (Test-Path -LiteralPath $NssmExe) {
      & $NssmExe stop $Name | Out-Null
    } else {
      Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    }
    # Wait up to 20s for it to stop.
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      if ((Get-Service -Name $Name -ErrorAction SilentlyContinue).Status -eq 'Stopped') { break }
    }
  }

  Write-Host "[svc] Removing '$Name'..."
  if (Test-Path -LiteralPath $NssmExe) {
    & $NssmExe remove $Name confirm | Out-Null
  } else {
    # Fallback if nssm.exe is gone: delete via sc.exe.
    & "$env:SystemRoot\System32\sc.exe" delete $Name | Out-Null
  }
  Write-Host "[svc] '$Name' removed."
}

Remove-NssmService -Name $WebServiceName
Remove-NssmService -Name $PollerServiceName
Write-Host "[svc] Done."
