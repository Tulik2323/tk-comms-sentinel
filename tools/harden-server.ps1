<#
.SYNOPSIS
  Hardens the server that runs TK Comms Sentinel under IIS: file permissions, plus two optional steps.

.DESCRIPTION
  Run it from an elevated PowerShell (Run as administrator). It is safe by default:
    1. It saves the current permissions (and the current IIS identity setting) to a backup folder.
    2. It applies the new permissions. SYSTEM and Administrators get their own entries before
       inheritance is cut, so files they do not own (the database -wal/-shm and the iisnode logs,
       created by the application pool) never become unreachable.
    3. It recycles the application pool and checks that the site still answers.
    4. If any step fails, or the site does not answer, it puts everything back by itself.
       Items an administrator cannot open are listed, and a restore-as-system.cmd is written to the
       backup folder that puts them back as SYSTEM (through a one-off scheduled task).

  What the default run changes:
    * Removes "Users" and "IIS_IUSRS" from the site folder, the database folder, the encryption key
      folder and the license signing key. Today every local user, and every other IIS application on
      this server, can read the JWT secret (.env), the database and the encryption key, and can also
      overwrite code that the poller runs as SYSTEM.
    * The application pool identity keeps read access to the code and write access only to the
      folders it must write to (database, logs).
    * SYSTEM and Administrators keep full control, so the poller task and deploy-local.ps1 keep working.
    * The site's anonymous requests are switched from the shared IUSR account to the application pool
      identity (the setting recommended for Node sites). IIS locks that section by default, so it is
      written to applicationHost.config for this site. If that still fails, or with -NoIisChanges,
      IUSR keeps read-only access to the site instead of losing it.

  Optional steps (off by default, each needs its own switch):
    -DisableOldTls    turns off TLS 1.0 and 1.1 for the whole server (needs a reboot; affects every
                      HTTPS site on this server, so only use it when all clients are modern).
    -RotateJwtSecret  replaces JWT_SECRET in backend\.env with a new random value. Everyone is logged
                      out once and has to sign in again.

  To undo the permission change:  harden-server.ps1 -Restore <backup folder printed by the run>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\dev\tkcs-installer\tools\harden-server.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\dev\tkcs-installer\tools\harden-server.ps1 -RotateJwtSecret
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $SiteRoot    = 'C:\inetpub\wwwroot\tkcommssentinel',
  [string] $SiteName    = 'tkcommssentinel',
  [string] $AppPool     = 'tkcommssentinel',
  [string] $DataDir     = 'C:\ProgramData\tknetmonitor',
  [string] $LicenseKey  = 'C:\dev\tkcs-installer\tools\keygen\private.pem',
  [string] $NodeExe     = 'C:\Program Files\nodejs\node.exe',
  [string] $HealthHost  = $env:COMPUTERNAME,
  [int]    $HttpsPort   = 9443,
  [string] $BackupRoot  = (Join-Path $env:ProgramData 'tkcs-hardening-backup'),
  [switch] $DisableOldTls,
  [switch] $RotateJwtSecret,
  [switch] $SkipHealthCheck,
  [switch] $NoIisChanges,
  [string] $Restore
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   NOTE $msg" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this script from an elevated PowerShell (Run as administrator).' }

# Runs icacls and returns its output lines. PowerShell 5.1 with ErrorActionPreference=Stop turns the first
# stderr line of a native command into a terminating error, so it is relaxed here and the exit code decides.
function Get-IcaclsResult([string[]]$IcaclsArgs) {
  $ErrorActionPreference = 'Continue'
  $out = @(& icacls.exe @IcaclsArgs 2>&1 | ForEach-Object { "$_" })
  $exit = $LASTEXITCODE
  # with /C icacls can exit 0 although it skipped items; its summary line still counts them
  $failed = 0
  foreach ($l in $out) { if ($l -match 'Failed processing (\d+) files') { $failed += [int]$Matches[1] } }
  return [pscustomobject]@{ Ok = ($exit -eq 0 -and $failed -eq 0); Exit = $exit; Lines = $out }
}

# icacls wrapper: fail loudly instead of continuing with half-applied permissions
function Invoke-Icacls {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $IcaclsArgs)
  $r = Get-IcaclsResult $IcaclsArgs
  if (-not $r.Ok) { throw "icacls $($IcaclsArgs -join ' ') failed (exit $($r.Exit)): $(($r.Lines | Select-Object -First 5) -join ' ')" }
}

# Same, but keeps going: returns the paths icacls could not process ("C:\path: Access is denied.")
function Invoke-IcaclsSoft {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $IcaclsArgs)
  $r = Get-IcaclsResult $IcaclsArgs
  if ($r.Ok) { return @() }
  $paths = @($r.Lines | ForEach-Object { if ($_ -match '^([A-Za-z]:\\.+?): ') { $Matches[1] } })
  if ($paths.Count -eq 0) { $paths = @("icacls $($IcaclsArgs -join ' ') (exit $($r.Exit)): $($r.Lines -join ' ')") }
  return $paths
}

# Items under $Path that Administrators can no longer open. icacls skips such an item without a word when
# it propagates or restores (and /restore still exits 0), so the only reliable check is to read them all.
# A plain listing is used on purpose: /save reads through the backup privilege and would not notice.
function Get-UnreachableItems([string]$Path) {
  return @(Invoke-IcaclsSoft $Path '/T' '/C')
}

$pool = "IIS AppPool\$AppPool"

# Users, IIS_IUSRS, Authenticated Users, Everyone, IUSR (by SID, so it works on any Windows language).
# /inheritance:r only drops INHERITED entries; an entry added directly on the folder survives it, so these
# are removed by name as well.
$stripPrincipals = @('*S-1-5-32-545', '*S-1-5-32-568', '*S-1-5-11', '*S-1-1-0', '*S-1-5-17')

# IIS locks anonymousAuthentication by default (overrideModeDefault="Deny"): the site's own web.config may
# not hold it, so it is read and written in applicationHost.config under a location tag for this site.
$anonFilter = 'system.webServer/security/authentication/anonymousAuthentication'
function Get-AnonUser {
  if ($NoIisChanges) { return $null }
  Import-Module WebAdministration -ErrorAction Stop
  return (Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter $anonFilter -Name userName).Value
}
function Set-AnonUser([string]$value) {
  if ($NoIisChanges) { return }
  Import-Module WebAdministration -ErrorAction Stop
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter $anonFilter -Name userName -Value $value
}

# The health check runs in Node, not PowerShell 5.1: its TLS stack cannot complete a handshake with this site.
function Test-SiteAnswers {
  if ($SkipHealthCheck) { return $true }
  if (-not (Test-Path -LiteralPath $NodeExe)) { Write-Warn "Node not found at $NodeExe - skipping the health check"; return $true }
  $js = @"
const https = require('https');
const req = https.get({ host: '$HealthHost', port: $HttpsPort, path: '/api/health', rejectUnauthorized: false, timeout: 8000 }, res => {
  let d = ''; res.on('data', c => d += c); res.on('end', () => process.exit(/"status"\s*:\s*"ok"/.test(d) ? 0 : 2));
});
req.on('error', () => process.exit(3)); req.on('timeout', () => { req.destroy(); process.exit(4); });
"@
  $tmp = Join-Path $env:TEMP ('tkcs-health-{0}.js' -f [guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($tmp, $js, (New-Object Text.ASCIIEncoding))
  try {
    for ($i = 1; $i -le 12; $i++) {           # the first request after a recycle starts Node: allow ~1 minute
      & $NodeExe $tmp | Out-Null
      if ($LASTEXITCODE -eq 0) { return $true }
      Start-Sleep -Seconds 5
    }
    return $false
  } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

function Restart-Pool {
  if ($SkipHealthCheck -or $NoIisChanges) { return }
  try {
    Import-Module WebAdministration -ErrorAction Stop
    Restart-WebAppPool -Name $AppPool
  } catch { Write-Warn "Could not recycle the application pool '$AppPool': $($_.Exception.Message)" }
}

# Writes restore-as-system.cmd into the backup folder and prints how to run it. It is for items an
# administrator cannot open at all: on some servers no administrator holds SeTakeOwnershipPrivilege,
# but SYSTEM always does. The scheduled task's /tr is limited to 261 characters, hence a .cmd file.
function Write-SystemRestoreHelper([string]$Folder, [string[]]$Paths) {
  $cmd = Join-Path $Folder 'restore-as-system.cmd'
  $lines = @('@echo off',
    'rem Written by harden-server.ps1: puts the saved permissions back as SYSTEM.',
    'set LOG=%~dp0restore-as-system.log',
    'echo === start %date% %time% > "%LOG%"')
  foreach ($p in ($Paths | Where-Object { $_ -match '^[A-Za-z]:\\' } | Select-Object -Unique)) {
    $lines += "takeown /A /F `"$p`" >> `"%LOG%`" 2>&1"
  }
  foreach ($line in Get-Content -LiteralPath (Join-Path $Folder 'targets.txt')) {
    $parts = $line -split '\|', 2
    $lines += "icacls `"$(Split-Path $parts[1] -Parent)`" /restore `"%~dp0$($parts[0])`" /C >> `"%LOG%`" 2>&1"
  }
  $lines += 'echo === done %date% %time% >> "%LOG%"'
  Set-Content -LiteralPath $cmd -Value $lines -Encoding ASCII
  Write-Host '   Some items could not be restored by an administrator. Put them back as SYSTEM:' -ForegroundColor Yellow
  Write-Host "     schtasks /create /tn `"TKCS-Restore-As-System`" /tr `"$cmd`" /sc once /st 23:59 /ru SYSTEM /f"
  Write-Host '     schtasks /run /tn "TKCS-Restore-As-System"'
  Write-Host "     (after a minute) type `"$(Join-Path $Folder 'restore-as-system.log')`""
  Write-Host '     schtasks /delete /tn "TKCS-Restore-As-System" /f'
}

# Puts back the permissions (and the IIS identity) saved in a backup folder. Goes through every target even
# when some items fail, and returns the items it could not put back.
function Restore-FromBackup([string]$Folder) {
  $map = Join-Path $Folder 'targets.txt'
  if (-not (Test-Path -LiteralPath $map)) { throw "No targets.txt in $Folder - is this a backup folder created by this script?" }
  $failed = @()
  foreach ($line in Get-Content -LiteralPath $map) {
    $parts = $line -split '\|', 2
    $bad = @(Invoke-IcaclsSoft (Split-Path $parts[1] -Parent) '/restore' (Join-Path $Folder $parts[0]) '/C')
    if (Test-Path -LiteralPath $parts[1]) { $bad = @($bad + (Get-UnreachableItems $parts[1]) | Select-Object -Unique) }
    if ($bad.Count -eq 0) { Write-Ok "restored permissions of $($parts[1])" }
    else {
      Write-Warn "$($parts[1]): $($bad.Count) item(s) could not be restored"
      $bad | Select-Object -First 10 | ForEach-Object { Write-Host "        $_" }
      $failed += $bad
    }
  }
  $anonFile = Join-Path $Folder 'anon-user.txt'
  if ((Test-Path -LiteralPath $anonFile) -and -not $NoIisChanges) {
    try {
      Set-AnonUser (Get-Content -LiteralPath $anonFile -Raw).Trim()
      Write-Ok 'restored the IIS anonymous identity'
    } catch {
      Write-Warn "could not restore the IIS anonymous identity: $($_.Exception.Message)"
      $failed += "IIS anonymous identity of $SiteName"
    }
  }
  if ($failed.Count -gt 0) { Write-SystemRestoreHelper $Folder $failed }
  return ,$failed
}

# ------------------------------------------------------------------ restore mode
if ($Restore) {
  Write-Step "Restoring from $Restore"
  if ($PSCmdlet.ShouldProcess($Restore, 'restore saved permissions')) {
    $left = Restore-FromBackup $Restore
    Restart-Pool
    if (Test-SiteAnswers) { Write-Ok 'the site answers' } else { Write-Warn 'the site did not answer after the restore - check IIS' }
    if ($left.Count -eq 0) { Write-Host "`nEverything was restored." -ForegroundColor Green }
    else { Write-Host "`n$($left.Count) item(s) still need the SYSTEM step printed above." -ForegroundColor Yellow }
  }
  return
}

# ------------------------------------------------------------------ 1. file permissions
Write-Step '1/3  File permissions'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot $stamp
$backendDir = Join-Path $SiteRoot 'backend'
$writable   = @('db', 'iisnode-logs', 'logs') | ForEach-Object { Join-Path $backendDir $_ } | Where-Object { Test-Path -LiteralPath $_ }
$siteData   = Join-Path $SiteRoot 'data'
if (Test-Path -LiteralPath $siteData) { $writable += $siteData }

if (-not (Test-Path -LiteralPath $SiteRoot)) { throw "Site folder not found: $SiteRoot" }
$targets = @($SiteRoot)
if (Test-Path -LiteralPath $DataDir)    { $targets += $DataDir }
if (Test-Path -LiteralPath $LicenseKey) { $targets += $LicenseKey }

if ($PSCmdlet.ShouldProcess($SiteRoot, 'save current permissions and apply the hardened ones')) {
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $i = 0; $mapLines = @()
  foreach ($t in $targets) {
    $i++
    $name = "acl$i.txt"
    Invoke-Icacls $t '/save' (Join-Path $backup $name) '/T' '/C'
    $mapLines += "$name|$t"
  }
  Set-Content -LiteralPath (Join-Path $backup 'targets.txt') -Value $mapLines -Encoding ASCII
  $origAnon = Get-AnonUser
  if ($null -ne $origAnon) { Set-Content -LiteralPath (Join-Path $backup 'anon-user.txt') -Value $origAnon -Encoding ASCII }
  Write-Ok "current permissions saved to $backup"

  try {
    # IIS identity: anonymous requests run as the application pool identity instead of the shared IUSR account.
    # When that cannot be set, IUSR still has to read server.js, so it keeps read-only access below.
    $keepIusr = $true
    if (-not $NoIisChanges) {
      try {
        Set-AnonUser ''
        $keepIusr = $false
        Write-Ok "IIS anonymous identity for '$SiteName': application pool identity (was '$origAnon')"
      } catch {
        Write-Warn "could not switch the IIS anonymous identity ($($_.Exception.Message)). IUSR stays, with read-only access."
      }
    }
    $strip = @($stripPrincipals | Where-Object { -not ($keepIusr -and $_ -eq '*S-1-5-17') })

    # Site tree: SYSTEM and Administrators full, the application pool read-only, nobody else.
    # Order matters: SYSTEM and Administrators get their own entries on the folder BEFORE inheritance is cut.
    # Files they do not own (created by the application pool: the database -wal/-shm, iisnode logs) are
    # reachable only through inherited entries; cutting inheritance first locked them out for good.
    Invoke-Icacls $SiteRoot '/grant' 'NT AUTHORITY\SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)'
    # The few places the web application must write to get their entry before the pool drops to read-only
    # (and again after the /reset below, which clears it), so the database stays writable for the site.
    foreach ($w in $writable) { Invoke-Icacls $w '/grant:r' "${pool}:(OI)(CI)(M)" }
    Invoke-Icacls $SiteRoot '/inheritance:r'
    Invoke-Icacls $SiteRoot '/grant:r' "${pool}:(OI)(CI)(RX)"
    if ($keepIusr) { Invoke-Icacls $SiteRoot '/grant:r' '*S-1-5-17:(OI)(CI)(RX)' }
    Invoke-Icacls $SiteRoot '/remove:g' @strip
    # children: drop their own leftovers so they inherit the folder above (icacls processes the entries inside, not the folder)
    Invoke-Icacls (Join-Path $SiteRoot '*') '/reset' '/T' '/C'
    Write-Ok 'site folder: the application pool is now read-only, Users and IIS_IUSRS removed'

    foreach ($w in $writable) {
      Invoke-Icacls $w '/grant:r' "${pool}:(OI)(CI)(M)"
      Write-Ok "application pool can write to $w"
    }

    # Guard: every item must still be reachable by Administrators. icacls skips a child it cannot open
    # without saying so, and a file nobody but the application pool can reach is a trap for the next
    # restore or reboot (SYSTEM runs the poller and must open the database files).
    $unreachable = @(Get-UnreachableItems $SiteRoot)
    if ($unreachable.Count -gt 0) {
      $unreachable | Select-Object -First 10 | ForEach-Object { Write-Host "        $_" }
      throw "$($unreachable.Count) item(s) in the site folder can no longer be opened by Administrators"
    }
    Write-Ok 'every item in the site folder is still reachable by SYSTEM and Administrators'

    # Encryption key + license files (the pool reads the key and writes license/trial files)
    if (Test-Path -LiteralPath $DataDir) {
      Invoke-Icacls $DataDir '/grant' 'NT AUTHORITY\SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)'
      Invoke-Icacls $DataDir '/inheritance:r'
      Invoke-Icacls $DataDir '/grant:r' "${pool}:(OI)(CI)(M)"
      Invoke-Icacls $DataDir '/remove:g' @stripPrincipals
      Invoke-Icacls (Join-Path $DataDir '*') '/reset' '/T' '/C'
      Write-Ok "$DataDir : only SYSTEM, Administrators and the application pool"
    }

    # The license signing key does not belong on a production server at all; until it is moved, lock it down.
    if (Test-Path -LiteralPath $LicenseKey) {
      Invoke-Icacls $LicenseKey '/grant:r' 'NT AUTHORITY\SYSTEM:(F)' 'BUILTIN\Administrators:(F)'
      Invoke-Icacls $LicenseKey '/inheritance:r'
      Invoke-Icacls $LicenseKey '/remove:g' @stripPrincipals
      Write-Ok "$LicenseKey : Administrators and SYSTEM only"
      Write-Warn 'Better: move that file to an offline USB drive or another computer, and delete it from this server.'
    }

    Restart-Pool
    if (-not (Test-SiteAnswers)) { throw 'the site did NOT answer after the change' }
    Write-Ok 'the site answers after the change'
  } catch {
    # Any failure, including a site that stopped answering: put the saved permissions back right away, so
    # the server is never left half-changed. The optional TLS and JWT steps below do not run.
    Write-Host "   Failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '   Putting the previous permissions back...' -ForegroundColor Yellow
    $left = Restore-FromBackup $backup
    Restart-Pool
    if ($left.Count -eq 0) {
      Write-Host '   Everything was restored to its previous state. Nothing else was changed. Send me the output above.' -ForegroundColor Yellow
    } else {
      Write-Host "   $($left.Count) item(s) are not restored yet: run the SYSTEM step printed above. Backup: $backup" -ForegroundColor Red
    }
    throw
  }
}

# ------------------------------------------------------------------ 2. optional: TLS 1.0 / 1.1
if ($DisableOldTls) {
  Write-Step '2/3  Turning off TLS 1.0 and 1.1 (whole server)'
  Write-Warn 'This affects every HTTPS site on this server. Clients older than TLS 1.2 (Windows 7, very old browsers, some scanners) will stop connecting.'
  foreach ($proto in 'TLS 1.0', 'TLS 1.1') {
    foreach ($side in 'Server', 'Client') {
      $key = "HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\$proto\$side"
      if ($PSCmdlet.ShouldProcess("$proto $side", 'disable')) {
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 'Enabled' -Value 0 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name 'DisabledByDefault' -Value 1 -PropertyType DWord -Force | Out-Null
      }
    }
  }
  Write-Ok 'TLS 1.0 and 1.1 disabled in the registry. A REBOOT of the server is needed for it to take effect.'
}

# ------------------------------------------------------------------ 3. optional: rotate the JWT secret
if ($RotateJwtSecret) {
  Write-Step '3/3  Replacing the JWT secret'
  $envFile = Join-Path $backendDir '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { throw ".env not found at $envFile" }
  if ($PSCmdlet.ShouldProcess($envFile, 'replace JWT_SECRET')) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Copy-Item -LiteralPath $envFile -Destination "$envFile.bak-$stamp"
    $lines = [IO.File]::ReadAllLines($envFile)
    $found = $false
    $lines = @($lines | ForEach-Object { if ($_ -match '^\s*JWT_SECRET\s*=') { $found = $true; "JWT_SECRET=$secret" } else { $_ } })
    if (-not $found) { $lines += "JWT_SECRET=$secret" }
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
    Write-Ok ("JWT_SECRET replaced. The old .env was kept as .env.bak-$stamp - delete that copy once you are happy.")
    Restart-Pool
    if (Test-SiteAnswers) { Write-Ok 'the site answers. Every user must sign in again once.' }
    else { Write-Warn "the site did not answer - restore the old .env from .env.bak-$stamp" }
  }
}

Write-Host "`nDone. Backup of the previous settings: $backup" -ForegroundColor Green
Write-Host 'Not done by this script (needs a decision from you):' -ForegroundColor Yellow
Write-Host '  * Move tools\keygen\private.pem (the license signing key) off this server.'
Write-Host '  * The "NetMonitor Poller" task runs as SYSTEM. A dedicated low-privilege account would be safer.'
Write-Host '  * Switch the network devices from SNMP v2c to SNMP v3 when they support it.'
