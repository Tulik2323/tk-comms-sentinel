<#
.SYNOPSIS
  Apply a version-only update package to an existing TK Comms Sentinel
  install: copy the new version in, swap the "current" junction, restart the
  services, health-check, and roll back automatically if the check fails.

.DESCRIPTION
  SourcePackageDir is the output of  build-package.ps1 -VersionOnly  after
  extraction: it must contain exactly one  versions\<version>\  folder (with
  backend\ and frontend\dist\ inside). Steps:

    1. Copy versions\<version>\ into <InstallRoot>\versions\<version>\.
    2. Record the currently active version (for rollback).
    3. Stop both services.
    4. Repoint "current" at the new version (activate-version.ps1).
    5. Start both services.
    6. Health-check https://localhost:<HTTPS_PORT>/api/health for up to
       -HealthTimeoutSec. On failure: repoint "current" back, restart the
       services on the previous version, and exit with an error -- the
       previous version's files were never touched, so this is a clean
       rollback, not a reinstall.

  Never touches data\ (DB, certs, .env) -- only versions\ and the junction.
  Old version folders are left on disk (not pruned) so a rollback is always
  possible; pruning old versions is a separate, manual step for now.

  The health check uses a raw TcpClient + SslStream instead of
  Invoke-WebRequest: in testing, Invoke-WebRequest / ServicePointManager in
  Windows PowerShell 5.1 failed ("underlying connection was closed") against
  this exact server/cert combination even though a browser connected fine.
  TcpClient + SslStream with a permissive certificate callback sidesteps
  that stack entirely and proved reliable.

  Must run elevated (Administrator).

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot        = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [Parameter(Mandatory = $true)]
  [string] $SourcePackageDir,
  [string] $WebServiceName     = 'TKCommsSentinel',
  [string] $PollerServiceName  = 'TKCommsSentinelPoller',
  [int]    $HealthTimeoutSec   = 30,
  [switch] $NoRollback
)

$ErrorActionPreference = 'Stop'

function Copy-Tree([string]$From, [string]$To) {
  robocopy $From $To /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $From -> $To" }
}

# Reads a single KEY=VALUE from a .env-style file (first match wins).
function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split '=', 2)[1]
}

# Low-level HTTPS GET that does not go through Invoke-WebRequest / WinHttp --
# see .DESCRIPTION for why. Returns $true if the response contains "\"status\":\"ok\"".
#
# The certificate-validation callback MUST be cast to the delegate type
# explicitly. A bare scriptblock passed positionally to New-Object's
# constructor-argument matching does not reliably bind as a
# RemoteCertificateValidationCallback -- when it fails to bind, the SSL
# handshake fails certificate validation (self-signed cert), every attempt
# throws, and the loop times out and reports "unhealthy" even when the
# server is perfectly fine. That bug shipped in the first version of this
# function and produced a false failure (and a false "rollback also failed")
# in the field on SRV-APPS. $lastError makes any future failure visible
# instead of silently swallowed.
function Test-HealthEndpoint([int]$Port, [int]$TimeoutSec) {
  $deadline  = (Get-Date).AddSeconds($TimeoutSec)
  $lastError = $null
  $callback  = [System.Net.Security.RemoteCertificateValidationCallback]{ $true }
  while ((Get-Date) -lt $deadline) {
    $tcp = $null; $ssl = $null
    try {
      $tcp = New-Object System.Net.Sockets.TcpClient
      $tcp.Connect('127.0.0.1', $Port)
      $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
      $ssl.AuthenticateAsClient('localhost')
      $req = "GET /api/health HTTP/1.1`r`nHost: localhost`r`nConnection: close`r`n`r`n"
      $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
      $ssl.Write($bytes, 0, $bytes.Length)
      $ssl.Flush()
      $reader = New-Object System.IO.StreamReader($ssl)
      $body = $reader.ReadToEnd()
      $reader.Dispose()
      if ($body -match '"status"\s*:\s*"ok"') { return $true }
      $lastError = "unexpected response: " + $body.Substring(0, [Math]::Min(200, $body.Length))
    } catch {
      $lastError = $_.Exception.Message
    } finally {
      if ($ssl) { $ssl.Dispose() }
      if ($tcp) { $tcp.Close() }
    }
    Start-Sleep -Milliseconds 1000
  }
  Write-Host "[update] Health check never succeeded within ${TimeoutSec}s. Last error: $lastError"
  return $false
}

function Get-CurrentVersion([string]$InstallRoot) {
  $currentPath = Join-Path $InstallRoot 'current'
  $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
  if (-not $item -or $item.LinkType -ne 'Junction') { return $null }
  $target = @($item.Target)[0]
  if (-not $target) { return $null }
  return Split-Path -Leaf $target.TrimEnd('\')
}

# --- 1. Locate the new version in the source package ---
# Tolerate one extra wrapping folder (e.g. a zip built with includeBaseDirectory,
# so extracting lands versions\ one level deeper than SourcePackageDir) --
# look inside a single subfolder automatically instead of making the caller
# guess the exact archive layout.
$srcVersionsDir = Join-Path $SourcePackageDir 'versions'
if (-not (Test-Path -LiteralPath $srcVersionsDir)) {
  $subdirs = Get-ChildItem -LiteralPath $SourcePackageDir -Directory
  $nested  = $subdirs | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'versions') }
  if ($nested.Count -eq 1) {
    Write-Host "[update] versions\ not directly under $SourcePackageDir -- using nested folder '$($nested[0].Name)'."
    $SourcePackageDir = $nested[0].FullName
    $srcVersionsDir   = Join-Path $SourcePackageDir 'versions'
  } else {
    throw "Not a version package (no versions\ folder, directly or one level down): $SourcePackageDir"
  }
}
$found = Get-ChildItem -LiteralPath $srcVersionsDir -Directory
if ($found.Count -ne 1) { throw "Expected exactly one version folder under $srcVersionsDir, found $($found.Count)" }
$newVersion = $found[0].Name
$srcVersionDir = $found[0].FullName
if (-not (Test-Path -LiteralPath (Join-Path $srcVersionDir 'backend\server.js'))) {
  throw "$srcVersionDir does not look like a valid version (backend\server.js missing)"
}

$dstVersionDir = Join-Path $InstallRoot "versions\$newVersion"
if (Test-Path -LiteralPath $dstVersionDir) {
  throw "$dstVersionDir already exists -- remove it first if you intend to re-apply this version."
}

$previousVersion = Get-CurrentVersion $InstallRoot
Write-Host "Updating: $previousVersion -> $newVersion"

# --- 2. Copy the new version in (does not touch data\ or the current version) ---
Write-Host "[update] Copying $srcVersionDir -> $dstVersionDir"
Copy-Tree $srcVersionDir $dstVersionDir

# --- 3. Stop services (tolerate already-stopped / not-yet-installed) ---
function Stop-Both {
  foreach ($n in @($WebServiceName, $PollerServiceName)) {
    $svc = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $n -Force }
  }
}
function Start-Both {
  Start-Service -Name $WebServiceName
  Start-Service -Name $PollerServiceName
}

Write-Host "[update] Stopping services..."
Stop-Both

# --- 4. Swap the junction ---
& (Join-Path $PSScriptRoot 'activate-version.ps1') -InstallRoot $InstallRoot -Version $newVersion

# --- 5. Start on the new version ---
Write-Host "[update] Starting services on $newVersion..."
Start-Both

# --- 6. Health check, with automatic rollback on failure ---
$envPath    = Join-Path $InstallRoot 'data\.env'
$httpsPort  = [int](Get-EnvValue $envPath 'HTTPS_PORT')
if (-not $httpsPort) { $httpsPort = 9443 }

Write-Host "[update] Health-checking https://localhost:$httpsPort/api/health (timeout ${HealthTimeoutSec}s)..."
$ok = Test-HealthEndpoint -Port $httpsPort -TimeoutSec $HealthTimeoutSec

if ($ok) {
  Write-Host ""
  Write-Host "[update] SUCCESS: $newVersion is active and healthy."
  Write-Host "[update] Previous version ($previousVersion) kept on disk for manual rollback."
  return
}

Write-Host ""
Write-Host "[update] Health check FAILED for $newVersion."

if ($NoRollback -or -not $previousVersion) {
  Write-Host "[update] -NoRollback given or no previous version on record -- leaving $newVersion active. Investigate manually."
  throw "Update to $newVersion failed its health check."
}

Write-Host "[update] Rolling back to $previousVersion..."
Stop-Both
& (Join-Path $PSScriptRoot 'activate-version.ps1') -InstallRoot $InstallRoot -Version $previousVersion
Start-Both
$rollbackOk = Test-HealthEndpoint -Port $httpsPort -TimeoutSec $HealthTimeoutSec
if ($rollbackOk) {
  Write-Host "[update] Rollback to $previousVersion succeeded and is healthy."
} else {
  Write-Host "[update] WARNING: rollback to $previousVersion did not pass its health check either. Manual intervention needed."
}
throw "Update to $newVersion failed its health check; rolled back to $previousVersion."
