<#
.SYNOPSIS
  Assemble a TK Comms Sentinel package from the workspace, in the versioned
  install layout: portable Node + NSSM + versions\<version>\ (backend with
  production node_modules + built frontend) + installer scripts.

.DESCRIPTION
  Runs on the build machine (which has internet, for the npm install). The
  resulting package needs no internet on the target: node_modules is baked in.

  Default (full package, for a first install):

    <OutDir>\
      versions\<version>\
        backend\             app + production node_modules
        frontend\dist\       built UI
      node\                  portable Node runtime (shared across versions)
      tools\nssm.exe         service manager (shared)
      installer\scripts\     cert / service / firewall / activate / update scripts
      data\                  empty (DB, certs, .env created at install time)

  No "current" junction is created here -- junctions do not survive being
  zipped, so activate-version.ps1 creates/updates it on the TARGET machine
  after extraction (see installer\README.md).

  With -VersionOnly, only versions\<version>\ is produced (no node/tools/
  installer/data) -- a small update package for update.ps1 to apply to an
  existing install, without re-shipping the Node runtime or NSSM.

  Prerequisite: vendor\node\node.exe and vendor\nssm\nssm.exe must exist for
  a full package (run the vendor download step first; not needed with
  -VersionOnly). ASCII-only for PS 5.1.
#>
[CmdletBinding()]
param(
  [string] $Root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string] $OutDir = '',
  [switch] $VersionOnly,
  [string] $VersionOverride = ''
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $Root 'package' }

$feDist = Join-Path $Root 'frontend\dist'

function Assert-Path([string]$Path, [string]$Hint) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing: $Path`n  -> $Hint" }
}
Assert-Path (Join-Path $feDist 'index.html') 'Build the frontend: npm run build in frontend\.'

# Read version -- this names the versions\<version>\ folder. -VersionOverride
# lets a caller cut a package under a different version number without
# editing package.json (e.g. building a throwaway version to test update.ps1).
$pkgJson = Get-Content (Join-Path $Root 'backend\package.json') -Raw | ConvertFrom-Json
$version = if ($VersionOverride) { $VersionOverride } else { $pkgJson.version }

Write-Host "Building package v$version $(if ($VersionOnly) { '(version-only)' } else { '(full)' })"
Write-Host "  Root  : $Root"
Write-Host "  OutDir: $OutDir"
Write-Host ""

# Clean output.
if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# robocopy is far faster than Copy-Item for directories with many small files
# (the portable Node tree has thousands). Exit codes < 8 mean success.
function Copy-Tree([string]$From, [string]$To, [string[]]$ExtraArgs = @()) {
  $rcArgs = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') + $ExtraArgs
  robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $From -> $To" }
}

$versionDir = Join-Path $OutDir "versions\$version"

# --- backend (source only; production deps installed below) ---
$xd = @('node_modules','logs','certs','iisnode-logs')
$xf = @('.env','netmonitor.db*','*.db','*.db-shm','*.db-wal','*.db-journal')
Copy-Tree (Join-Path $Root 'backend') (Join-Path $versionDir 'backend') (@('/XD') + $xd + @('/XF') + $xf)

# --- frontend build ---
Copy-Tree $feDist (Join-Path $versionDir 'frontend\dist')

# --- install production dependencies with the PORTABLE node's npm (offline-ready output) ---
# VersionOnly still needs A node to run npm install; use the vendored one if
# present, else require the caller to have Node on PATH (falls back to "node").
$npmForInstall = if (Test-Path (Join-Path $Root 'vendor\node\npm.cmd')) { Join-Path $Root 'vendor\node\npm.cmd' } else { 'npm' }
Write-Host "Installing backend production dependencies..."
Push-Location (Join-Path $versionDir 'backend')
try {
  & $npmForInstall install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

if (-not $VersionOnly) {
  $vendorNode = Join-Path $Root 'vendor\node'
  $vendorNssm = Join-Path $Root 'vendor\nssm\nssm.exe'
  Assert-Path (Join-Path $vendorNode 'node.exe') 'Run the vendor download step (portable Node).'
  Assert-Path $vendorNssm                         'Run the vendor download step (NSSM).'

  Copy-Tree $vendorNode (Join-Path $OutDir 'node')
  Copy-Tree (Join-Path $Root 'installer\scripts') (Join-Path $OutDir 'installer\scripts')
  New-Item -ItemType Directory -Path (Join-Path $OutDir 'tools') -Force | Out-Null
  Copy-Item -Path $vendorNssm -Destination (Join-Path $OutDir 'tools\nssm.exe') -Force

  # Empty data dir (DB, certs, .env land here at install time).
  New-Item -ItemType Directory -Path (Join-Path $OutDir 'data') -Force | Out-Null
}

$sizeMB = [math]::Round(((Get-ChildItem -Recurse -File $OutDir | Measure-Object Length -Sum).Sum)/1MB, 1)
Write-Host ""
Write-Host "Package ready: $OutDir  ($sizeMB MB)"
if ($VersionOnly) {
  Write-Host "Version-only package for update.ps1. Apply it to an existing install; see installer\README.md."
} else {
  Write-Host "Full package. On a target server: run activate-version.ps1, then follow installer\README.md."
}
