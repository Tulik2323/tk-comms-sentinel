<#
.SYNOPSIS
  Assemble a self-contained, offline-ready TK Comms Sentinel package from the
  workspace: portable Node + NSSM + backend (with production node_modules) +
  built frontend + the installer scripts.

.DESCRIPTION
  Runs on the build machine (which has internet, for the npm install). The
  resulting package needs no internet on the target: node_modules is baked in.
  Layout produced (this folder IS the install root):

    <OutDir>\
      node\               portable Node runtime
      tools\nssm.exe       service manager
      backend\             app + production node_modules
      frontend\dist\       built UI
      installer\scripts\   cert / service / firewall scripts
      data\                empty (DB, certs, .env created at install time)

  Prerequisite: vendor\node\node.exe and vendor\nssm\nssm.exe must exist
  (run the vendor download step first). ASCII-only for PS 5.1.
#>
[CmdletBinding()]
param(
  [string] $Root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string] $OutDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $Root 'package' }

$vendorNode = Join-Path $Root 'vendor\node'
$vendorNssm = Join-Path $Root 'vendor\nssm\nssm.exe'
$feDist     = Join-Path $Root 'frontend\dist'

function Assert-Path([string]$Path, [string]$Hint) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing: $Path`n  -> $Hint" }
}
Assert-Path (Join-Path $vendorNode 'node.exe') 'Run the vendor download step (portable Node).'
Assert-Path $vendorNssm                         'Run the vendor download step (NSSM).'
Assert-Path (Join-Path $feDist 'index.html')    'Build the frontend: npm run build in frontend\.'

# Read version for the summary.
$pkgJson = Get-Content (Join-Path $Root 'backend\package.json') -Raw | ConvertFrom-Json
$version = $pkgJson.version

Write-Host "Building package v$version"
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

# --- backend (source only; production deps installed below) ---
$xd = @('node_modules','logs','certs','iisnode-logs')
$xf = @('.env','netmonitor.db*','*.db','*.db-shm','*.db-wal','*.db-journal')
Copy-Tree (Join-Path $Root 'backend') (Join-Path $OutDir 'backend') (@('/XD') + $xd + @('/XF') + $xf)

# --- frontend build ---
Copy-Tree $feDist (Join-Path $OutDir 'frontend\dist')

# --- portable node + nssm + installer scripts ---
Copy-Tree $vendorNode (Join-Path $OutDir 'node')
Copy-Tree (Join-Path $Root 'installer\scripts') (Join-Path $OutDir 'installer\scripts')
New-Item -ItemType Directory -Path (Join-Path $OutDir 'tools') -Force | Out-Null
Copy-Item -Path $vendorNssm -Destination (Join-Path $OutDir 'tools\nssm.exe') -Force

# --- empty data dir (DB, certs, .env land here at install time) ---
New-Item -ItemType Directory -Path (Join-Path $OutDir 'data') -Force | Out-Null

# --- install production dependencies with the PORTABLE node's npm (offline-ready output) ---
Write-Host "Installing backend production dependencies with portable npm..."
$npmCmd = Join-Path $OutDir 'node\npm.cmd'
Push-Location (Join-Path $OutDir 'backend')
try {
  & $npmCmd install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

$sizeMB = [math]::Round(((Get-ChildItem -Recurse -File $OutDir | Measure-Object Length -Sum).Sum)/1MB, 1)
Write-Host ""
Write-Host "Package ready: $OutDir  ($sizeMB MB)"
Write-Host "Next on a target server: follow installer\README.md (generate cert, write .env, svc-install, open-firewall, seed-admin)."
