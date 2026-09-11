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

  The health check shells out to the bundled portable Node runtime
  (<InstallRoot>\node\node.exe) instead of using any Windows-native TLS
  client. Two different Windows TLS clients were tried and both failed on a
  hardened test server (SRV-APPS) even though the server was genuinely
  healthy (confirmed by a real browser connecting fine): Invoke-WebRequest /
  ServicePointManager ("underlying connection was closed"), then a raw
  TcpClient + SslStream ("A call to SSPI failed"). Both go through Windows'
  SChannel TLS provider, which a hardened server's cipher/protocol policy
  can block outright. Node's own TLS client uses OpenSSL directly -- the
  same stack the server itself uses -- so it is not subject to that policy.

  Must run elevated (Administrator).

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot        = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [Parameter(Mandatory = $true)]
  [string] $SourcePackageDir,
  [string] $NodeExe            = '',
  [string] $WebServiceName     = 'TKCommsSentinel',
  [string] $PollerServiceName  = 'TKCommsSentinelPoller',
  [int]    $HealthTimeoutSec   = 30,
  [switch] $NoRollback
)

$ErrorActionPreference = 'Stop'
if (-not $NodeExe) { $NodeExe = Join-Path $InstallRoot 'node\node.exe' }
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "node.exe not found: $NodeExe" }

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

# HTTPS GET via the bundled portable Node runtime -- see .DESCRIPTION for why
# no Windows-native TLS client (SslStream, Invoke-WebRequest/WinHTTP) is used.
# A tiny script is written once to a temp file and re-run each poll; Node's
# own exit code (0 = healthy) is the signal, avoiding any PowerShell-side TLS
# handling entirely.
function Test-HealthEndpoint([string]$NodeExe, [int]$Port, [int]$TimeoutSec) {
  $js = @'
var https = require("https");
var port = parseInt(process.argv[2], 10);
var req = https.get({
  hostname: "127.0.0.1", port: port, path: "/api/health",
  rejectUnauthorized: false, timeout: 5000
}, function (res) {
  var data = "";
  res.on("data", function (c) { data += c; });
  res.on("end", function () {
    process.exit(/"status"\s*:\s*"ok"/.test(data) ? 0 : 2);
  });
});
req.on("timeout", function () { req.destroy(); process.exit(3); });
req.on("error", function () { process.exit(1); });
'@
  $scriptPath = Join-Path $env:TEMP ("tkcs-health-check-{0}.js" -f [System.Guid]::NewGuid().ToString('N'))
  [System.IO.File]::WriteAllText($scriptPath, $js, (New-Object System.Text.ASCIIEncoding))

  $deadline  = (Get-Date).AddSeconds($TimeoutSec)
  $lastError = $null
  try {
    while ((Get-Date) -lt $deadline) {
      & $NodeExe $scriptPath $Port 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return $true }
      $lastError = switch ($LASTEXITCODE) {
        1       { 'connection error (server not up yet?)' }
        2       { 'reached the server but response was not "status":"ok"' }
        3       { 'request timed out (5s)' }
        default { "node exit code $LASTEXITCODE" }
      }
      Start-Sleep -Milliseconds 1000
    }
  } finally {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[update] Health check never succeeded within ${TimeoutSec}s. Last status: $lastError"
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
$ok = Test-HealthEndpoint -NodeExe $NodeExe -Port $httpsPort -TimeoutSec $HealthTimeoutSec

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
$rollbackOk = Test-HealthEndpoint -NodeExe $NodeExe -Port $httpsPort -TimeoutSec $HealthTimeoutSec
if ($rollbackOk) {
  Write-Host "[update] Rollback to $previousVersion succeeded and is healthy."
} else {
  Write-Host "[update] WARNING: rollback to $previousVersion did not pass its health check either. Manual intervention needed."
}
throw "Update to $newVersion failed its health check; rolled back to $previousVersion."
