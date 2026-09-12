<#
.SYNOPSIS
  Create or repoint the "current" directory junction at a version under
  versions\, for the TK Comms Sentinel versioned install layout.

.DESCRIPTION
  <InstallRoot>\current is a directory junction (not a symlink -- junctions
  need no special privilege on Windows) pointing at <InstallRoot>\versions\
  <Version>\. Services are configured once, against the stable path
  <InstallRoot>\current\backend, and never need reconfiguring: swapping this
  junction is what makes an update (or a rollback) take effect.

  Also (re)writes <InstallRoot>\VERSION as a plain text file containing just
  the active version string. This is the one thing every consumer -- an
  Admin-UI "check for updates" feature comparing against a feed, a support
  script, a future updater -- reads to learn the currently-running version,
  instead of reaching into versions\<x>\backend\package.json through the
  junction (which requires knowing this layout and a JSON parse). Always
  rewritten, even on the no-op path, so it can never drift from reality.

  With no -Version, activates the highest version folder present under
  versions\ (by a simple version-string sort) -- the common case right after
  extracting a first-install package that ships exactly one version.

  Safe to call with the services running: a directory junction repoint is
  atomic from the filesystem's point of view, but the running Node process
  already has the old files open, so callers (update.ps1) still stop the
  services first, swap, then start them again.

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $Version     = ''
)

$ErrorActionPreference = 'Stop'

$versionsDir = Join-Path $InstallRoot 'versions'
if (-not (Test-Path -LiteralPath $versionsDir)) { throw "versions directory not found: $versionsDir" }

if (-not $Version) {
  $candidates = Get-ChildItem -LiteralPath $versionsDir -Directory | Select-Object -ExpandProperty Name
  if (-not $candidates) { throw "No version folders found under $versionsDir" }
  # Simple sort: split on '.', compare numerically component by component.
  # Good enough for plain x.y.z version numbers; not a full semver sort.
  $Version = $candidates | Sort-Object {
    $parts = $_ -split '\.'
    [version]("{0}.{1}.{2}" -f
      ($(if ($parts.Count -gt 0) { $parts[0] } else { 0 })),
      ($(if ($parts.Count -gt 1) { $parts[1] } else { 0 })),
      ($(if ($parts.Count -gt 2) { $parts[2] } else { 0 }))
    )
  } | Select-Object -Last 1
  Write-Host "[activate] No -Version given; highest found: $Version"
}

$targetDir = Join-Path $versionsDir $Version
if (-not (Test-Path -LiteralPath $targetDir)) { throw "Version not found: $targetDir" }
if (-not (Test-Path -LiteralPath (Join-Path $targetDir 'backend\server.js'))) {
  throw "$targetDir does not look like a valid version (backend\server.js missing)"
}

$currentPath = Join-Path $InstallRoot 'current'

$existing = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.LinkType -ne 'Junction') {
    throw "$currentPath exists and is not a junction (LinkType: $($existing.LinkType)) -- refusing to touch it."
  }
  # Get-Item on a junction reports its target in .Target (an array in newer
  # PowerShell versions; take the first element either way).
  $currentTarget = @($existing.Target)[0]
  $alreadyCorrect = $currentTarget -and ($currentTarget.TrimEnd('\') -eq $targetDir.TrimEnd('\'))
  if ($alreadyCorrect) {
    Write-Host "[activate] 'current' already points at $Version -- nothing to do."
  } else {
    Write-Host "[activate] Repointing 'current' from '$currentTarget' to '$targetDir'."
    # Remove-Item on a junction can prompt for confirmation (and fails outright
    # in a non-interactive session) because it treats the reparse point like a
    # populated folder. [IO.Directory]::Delete($path, $false) removes only the
    # junction/reparse point itself and never touches the target's content.
    [System.IO.Directory]::Delete($currentPath, $false)
  }
} else {
  $alreadyCorrect = $false
  Write-Host "[activate] Creating 'current' -> '$targetDir'."
}

if (-not $alreadyCorrect) {
  New-Item -ItemType Junction -Path $currentPath -Target $targetDir | Out-Null
}

# Plain-text, no trailing newline concerns for readers -- just the version
# string. ASCII is sufficient (version numbers are ASCII by construction).
[System.IO.File]::WriteAllText((Join-Path $InstallRoot 'VERSION'), $Version, (New-Object System.Text.ASCIIEncoding))
Write-Host "[activate] Active version: $Version"
