<#
.SYNOPSIS
  Collect a self-contained diagnostic bundle from a TK Comms Sentinel install,
  for sending to support when something is not working as expected.

.DESCRIPTION
  Read-only: never stops a service, never modifies any file, never touches
  the database beyond opening it for a read-only schema/count check. Safe to
  run at any time, does not require Administrator (service status/log reads
  work for any local user; only actions that would need elevation, like
  restarting a service, are deliberately NOT part of this script).

  Collects, into a single timestamped text report:
    - Installed version (VERSION file + backend/frontend package.json),
      which version the "current" junction actually points at.
    - Windows service status for both services (running/stopped, PID).
    - The "NetMonitor Poller" Scheduled Task (IIS deployments run the
      poller this way instead of as a service).
    - The last N lines of each service's stdout/stderr log
      (data\logs\<service>.out.log / .err.log).
    - Which frontend bundle files are on disk and their timestamps, plus the
      bundle filename index.html actually references -- catches "server has
      the new build but I'm still looking at an old cached page" at a
      glance.
    - Database schema shape (table list, column list for audit_log, whether
      hostname_cache exists) and ROW COUNTS ONLY for a few key tables.
      Deliberately never dumps actual row data: devices/mac_entries/
      alert_events routinely contain SNMP community strings, IP/MAC
      inventory and similar site-specific data that has no business leaving
      the site over email/chat.
    - Which non-secret settings exist in data\.env (key names only, never
      values -- .env holds JWT secrets, SMTP/LDAP passwords, PFX password).
    - OS version, portable Node.exe version, free disk space on the install
      drive.

  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collect-diagnostics.ps1
  Writes the report to the current user's Desktop and prints its path.
#>
[CmdletBinding()]
param(
  [string] $InstallRoot       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $WebServiceName    = 'TKCommsSentinel',
  [string] $PollerServiceName = 'TKCommsSentinelPoller',
  [string] $OutFile           = '',
  [int]    $LogTailLines      = 200
)

$ErrorActionPreference = 'Continue'

$dataDir = Join-Path $InstallRoot 'data'
$logDir  = Join-Path $dataDir 'logs'
$dbPath  = Join-Path $dataDir 'netmonitor.db'
$envPath = Join-Path $dataDir '.env'
$nodeExe = Join-Path $InstallRoot 'node\node.exe'

if (-not $OutFile) {
  $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $OutFile = Join-Path $desktop "tkcs-diagnostics-$stamp.txt"
}

$sb = New-Object System.Text.StringBuilder
function Add-Line([string]$Text = '') { [void]$sb.AppendLine($Text) }
function Add-Section([string]$Title) {
  Add-Line ''
  Add-Line ('=' * 70)
  Add-Line $Title
  Add-Line ('=' * 70)
}

Add-Line "TK Comms Sentinel diagnostics"
Add-Line "Generated : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Add-Line "InstallRoot: $InstallRoot"

# ---- Version info ----
Add-Section "VERSION"
$versionFile = Join-Path $InstallRoot 'current\VERSION'
if (-not (Test-Path -LiteralPath $versionFile)) { $versionFile = Join-Path $InstallRoot 'VERSION' }
if (Test-Path -LiteralPath $versionFile) {
  Add-Line "VERSION file: $((Get-Content -LiteralPath $versionFile -Raw).Trim())"
} else {
  Add-Line "VERSION file: not found ($versionFile)"
}

$currentLink = Join-Path $InstallRoot 'current'
$currentItem = Get-Item -LiteralPath $currentLink -Force -ErrorAction SilentlyContinue
if ($currentItem -and $currentItem.LinkType -eq 'Junction') {
  Add-Line "current -> junction target: $(@($currentItem.Target)[0])"
} else {
  Add-Line "current -> not a junction (flat install layout, or missing)"
}

foreach ($pj in @('current\backend\package.json', 'current\frontend\package.json')) {
  $p = Join-Path $InstallRoot $pj
  if (Test-Path -LiteralPath $p) {
    try {
      $v = (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json).version
      Add-Line "$pj version: $v"
    } catch { Add-Line "$pj : could not parse ($($_.Exception.Message))" }
  } else {
    Add-Line "$pj : not found"
  }
}

# ---- Service status ----
Add-Section "SERVICES"
foreach ($svc in @($WebServiceName, $PollerServiceName)) {
  $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
  if ($s) {
    Add-Line "$svc : Status=$($s.Status)  StartType=$($s.StartType)"
  } else {
    Add-Line "$svc : service not found"
  }
}
try {
  $procs = Get-CimInstance Win32_Service -Filter "Name='$WebServiceName' or Name='$PollerServiceName'" -ErrorAction Stop
  foreach ($p in $procs) { Add-Line "  $($p.Name): PID=$($p.ProcessId) StartMode=$($p.StartMode)" }
} catch { }

# ---- Scheduled tasks ----
# IIS deployments have no Windows services: the site runs under iisnode and the
# poller runs as a Scheduled Task, so "service not found" above is expected there.
Add-Section "SCHEDULED TASKS"
foreach ($taskName in @('NetMonitor Poller')) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    Add-Line "$taskName : State=$($task.State)"
    if ($info) {
      Add-Line "  LastRunTime=$($info.LastRunTime)  LastTaskResult=$($info.LastTaskResult)  NextRunTime=$($info.NextRunTime)"
    }
  } else {
    Add-Line "$taskName : task not found"
  }
}

# ---- Recent logs ----
Add-Section "RECENT LOGS (last $LogTailLines lines each)"
foreach ($svc in @($WebServiceName, $PollerServiceName)) {
  foreach ($kind in @('out', 'err')) {
    $logFile = Join-Path $logDir "$svc.$kind.log"
    Add-Line ''
    Add-Line "--- $logFile ---"
    if (Test-Path -LiteralPath $logFile) {
      try {
        Get-Content -LiteralPath $logFile -Tail $LogTailLines -ErrorAction Stop | ForEach-Object { Add-Line $_ }
      } catch { Add-Line "(could not read: $($_.Exception.Message))" }
    } else {
      Add-Line "(not found)"
    }
  }
}

# ---- Frontend bundle on disk ----
Add-Section "FRONTEND BUNDLE"
$distDir = Join-Path $InstallRoot 'current\frontend\dist'
$indexHtml = Join-Path $distDir 'index.html'
if (Test-Path -LiteralPath $indexHtml) {
  $refs = Select-String -LiteralPath $indexHtml -Pattern 'assets/[A-Za-z0-9_.\-]+\.(js|css)' -AllMatches |
          ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique
  Add-Line "index.html references:"
  foreach ($r in $refs) { Add-Line "  $r" }
} else {
  Add-Line "index.html not found at $indexHtml"
}
$assetsDir = Join-Path $distDir 'assets'
if (Test-Path -LiteralPath $assetsDir) {
  Add-Line ''
  Add-Line "Files on disk in assets\:"
  Get-ChildItem -LiteralPath $assetsDir -File | ForEach-Object {
    Add-Line ("  {0,-40} {1,10} bytes  {2}" -f $_.Name, $_.Length, $_.LastWriteTime)
  }
} else {
  Add-Line "assets\ folder not found"
}

# ---- Database (read-only schema + counts, never row data) ----
Add-Section "DATABASE (schema and counts only -- no row data)"
if (-not (Test-Path -LiteralPath $dbPath)) {
  Add-Line "Database file not found: $dbPath"
} elseif (-not (Test-Path -LiteralPath $nodeExe)) {
  Add-Line "Portable node.exe not found: $nodeExe (cannot run the schema check)"
} else {
  $dbCheckJs = @'
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];
try {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  console.log("Tables: " + tables.join(", "));
  console.log("hostname_cache table present: " + tables.includes("hostname_cache"));
  if (tables.includes("audit_log")) {
    const cols = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
    console.log("audit_log columns: " + cols.join(", "));
    console.log("audit_log has msg_key/msg_params: " + (cols.includes("msg_key") && cols.includes("msg_params")));
  }
  for (const t of ["devices", "mac_entries", "alert_events", "audit_log", "ports", "hostname_cache"]) {
    if (tables.includes(t)) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
      console.log("row count " + t + ": " + n);
    }
  }
  if (tables.includes("hostname_cache")) {
    const resolved = db.prepare("SELECT COUNT(*) AS n FROM hostname_cache WHERE hostname IS NOT NULL").get().n;
    console.log("hostname_cache resolved (non-null hostname): " + resolved);
  }
  db.close();
} catch (e) {
  console.log("ERROR: " + e.message);
}
'@
  $dbCheckPath = Join-Path $env:TEMP ("tkcs-diag-dbcheck-{0}.js" -f [System.Guid]::NewGuid().ToString('N'))
  [System.IO.File]::WriteAllText($dbCheckPath, $dbCheckJs, (New-Object System.Text.ASCIIEncoding))
  try {
    $out = & $nodeExe $dbCheckPath $dbPath 2>&1
    foreach ($line in $out) { Add-Line $line }
  } finally {
    Remove-Item -LiteralPath $dbCheckPath -Force -ErrorAction SilentlyContinue
  }
}

# ---- .env: key names only, never values ----
Add-Section "ENVIRONMENT (data\.env -- key NAMES only, values never included)"
if (Test-Path -LiteralPath $envPath) {
  Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
      $key = $Matches[1]
      $hasValue = ($_ -replace '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*', '').Trim().Length -gt 0
      Add-Line ("  {0,-24} {1}" -f $key, $(if ($hasValue) { '(set)' } else { '(empty)' }))
    }
  }
} else {
  Add-Line ".env not found at $envPath"
}

# ---- System info ----
Add-Section "SYSTEM"
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line "OS: $($os.Caption) $($os.Version)"
} catch { }
if (Test-Path -LiteralPath $nodeExe) {
  try { Add-Line "Node: $(& $nodeExe --version)" } catch { }
} else {
  Add-Line "Node: portable node.exe not found at $nodeExe"
}
try {
  $drive = (Get-Item -LiteralPath $InstallRoot).PSDrive.Name
  $vol = Get-Volume -DriveLetter $drive -ErrorAction Stop
  Add-Line "Free space on ${drive}: $([math]::Round($vol.SizeRemaining / 1GB, 1)) GB of $([math]::Round($vol.Size / 1GB, 1)) GB"
} catch { }

# ---- Write out ----
[System.IO.File]::WriteAllText($OutFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host "Diagnostics written to:" -ForegroundColor Green
Write-Host "  $OutFile" -ForegroundColor Green
Write-Host ""
Write-Host "This file contains service status, recent logs, and database" -ForegroundColor Yellow
Write-Host "SCHEMA/COUNTS only (no device inventory, no SNMP community" -ForegroundColor Yellow
Write-Host "strings, no passwords). Safe to send for troubleshooting." -ForegroundColor Yellow
