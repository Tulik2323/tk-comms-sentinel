<#
.SYNOPSIS
  Hardens the server that runs TK Comms Sentinel under IIS: file permissions, plus two optional steps.

.DESCRIPTION
  Run it from an elevated PowerShell (Run as administrator). It is safe by default:
    1. It saves the current permissions (and the current IIS identity setting) to a backup folder.
    2. It applies the new permissions.
    3. It recycles the application pool and checks that the site still answers.
    4. If the site does not answer, it puts everything back by itself.

  What the default run changes:
    * Removes "Users" and "IIS_IUSRS" from the site folder, the database folder, the encryption key
      folder and the license signing key. Today every local user, and every other IIS application on
      this server, can read the JWT secret (.env), the database and the encryption key, and can also
      overwrite code that the poller runs as SYSTEM.
    * The application pool identity keeps read access to the code and write access only to the
      folders it must write to (database, logs).
    * SYSTEM and Administrators keep full control, so the poller task and deploy-local.ps1 keep working.
    * The site's anonymous requests are switched from the shared IUSR account to the application pool
      identity (the setting recommended for Node sites). Without it IUSR would need read access to the
      code, which is exactly what is being removed.

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

# icacls wrapper: fail loudly instead of continuing with half-applied permissions
function Invoke-Icacls {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $IcaclsArgs)
  $out = & icacls.exe @IcaclsArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $($IcaclsArgs -join ' ') failed (exit $LASTEXITCODE): $($out -join ' ')" }
}

$pool = "IIS AppPool\$AppPool"

# Users, IIS_IUSRS, Authenticated Users, Everyone, IUSR (by SID, so it works on any Windows language).
# /inheritance:r only drops INHERITED entries; an entry added directly on the folder survives it, so these
# are removed by name as well.
$stripPrincipals = @('*S-1-5-32-545', '*S-1-5-32-568', '*S-1-5-11', '*S-1-1-0', '*S-1-5-17')

function Get-AnonUser {
  if ($NoIisChanges) { return $null }
  Import-Module WebAdministration -ErrorAction Stop
  return (Get-WebConfigurationProperty -PSPath "IIS:\Sites\$SiteName" -Filter '/system.webServer/security/authentication/anonymousAuthentication' -Name userName).Value
}
function Set-AnonUser([string]$value) {
  if ($NoIisChanges) { return }
  Import-Module WebAdministration -ErrorAction Stop
  Set-WebConfigurationProperty -PSPath "IIS:\Sites\$SiteName" -Filter '/system.webServer/security/authentication/anonymousAuthentication' -Name userName -Value $value
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

# Puts back the permissions (and the IIS identity) saved in a backup folder
function Restore-FromBackup([string]$Folder) {
  $map = Join-Path $Folder 'targets.txt'
  if (-not (Test-Path -LiteralPath $map)) { throw "No targets.txt in $Folder - is this a backup folder created by this script?" }
  foreach ($line in Get-Content -LiteralPath $map) {
    $parts = $line -split '\|', 2
    Invoke-Icacls (Split-Path $parts[1] -Parent) '/restore' (Join-Path $Folder $parts[0]) '/C'
    Write-Ok "restored permissions of $($parts[1])"
  }
  $anonFile = Join-Path $Folder 'anon-user.txt'
  if ((Test-Path -LiteralPath $anonFile) -and -not $NoIisChanges) {
    Set-AnonUser (Get-Content -LiteralPath $anonFile -Raw).Trim()
    Write-Ok 'restored the IIS anonymous identity'
  }
}

# ------------------------------------------------------------------ restore mode
if ($Restore) {
  Write-Step "Restoring from $Restore"
  if ($PSCmdlet.ShouldProcess($Restore, 'restore saved permissions')) {
    Restore-FromBackup $Restore
    Restart-Pool
    if (Test-SiteAnswers) { Write-Ok 'the site answers' } else { Write-Warn 'the site did not answer after the restore - check IIS' }
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
    # IIS identity: anonymous requests run as the application pool identity instead of the shared IUSR account
    if (-not $NoIisChanges) {
      Set-AnonUser ''
      Write-Ok "IIS anonymous identity for '$SiteName': application pool identity (was '$origAnon')"
    }

    # Site tree: SYSTEM and Administrators full, the application pool read-only, nobody else.
    Invoke-Icacls $SiteRoot '/inheritance:r'
    Invoke-Icacls $SiteRoot '/grant:r' 'NT AUTHORITY\SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' "${pool}:(OI)(CI)(RX)"
    Invoke-Icacls $SiteRoot '/remove:g' @stripPrincipals
    # children: drop their own leftovers so they inherit the folder above (icacls processes the entries inside, not the folder)
    Invoke-Icacls (Join-Path $SiteRoot '*') '/reset' '/T' '/C'
    Write-Ok 'site folder: the application pool is now read-only, Users and IIS_IUSRS removed'

    # The few places the web application must write to.
    foreach ($w in $writable) {
      Invoke-Icacls $w '/grant:r' "${pool}:(OI)(CI)(M)"
      Write-Ok "application pool can write to $w"
    }

    # Encryption key + license files (the pool reads the key and writes license/trial files)
    if (Test-Path -LiteralPath $DataDir) {
      Invoke-Icacls $DataDir '/inheritance:r'
      Invoke-Icacls $DataDir '/grant:r' 'NT AUTHORITY\SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' "${pool}:(OI)(CI)(M)"
      Invoke-Icacls $DataDir '/remove:g' @stripPrincipals
      Invoke-Icacls (Join-Path $DataDir '*') '/reset' '/T' '/C'
      Write-Ok "$DataDir : only SYSTEM, Administrators and the application pool"
    }

    # The license signing key does not belong on a production server at all; until it is moved, lock it down.
    if (Test-Path -LiteralPath $LicenseKey) {
      Invoke-Icacls $LicenseKey '/inheritance:r'
      Invoke-Icacls $LicenseKey '/grant:r' 'NT AUTHORITY\SYSTEM:(F)' 'BUILTIN\Administrators:(F)'
      Invoke-Icacls $LicenseKey '/remove:g' @stripPrincipals
      Write-Ok "$LicenseKey : Administrators and SYSTEM only"
      Write-Warn 'Better: move that file to an offline USB drive or another computer, and delete it from this server.'
    }

    Restart-Pool
    if (Test-SiteAnswers) {
      Write-Ok 'the site answers after the change'
    } else {
      Write-Host '   The site did NOT answer after the change - putting the old settings back.' -ForegroundColor Red
      Restore-FromBackup $backup
      Restart-Pool
      throw 'Everything was restored to its previous state; nothing was left half-changed. Send me the output above.'
    }
  } catch {
    Write-Host "   Failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   To put everything back:  .\harden-server.ps1 -Restore `"$backup`"" -ForegroundColor Yellow
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
