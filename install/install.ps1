#Requires -RunAsAdministrator
# ================================================================
# TK COMMS SENTINEL - Automated Installation Script
# Compatible with: Windows Server 2019 / 2022 / 2025 (64-bit)
# Run: Right-click -> Run with PowerShell (as Administrator)
# ================================================================

param(
    [string]$InstallPath = "C:\inetpub\wwwroot\tkcommssentinel",
    [string]$SiteName    = "tkcommssentinel",
    [string]$AppPool     = "tkcommssentinel",
    [int]$Port           = 8080,
    [string]$TaskName    = "TK Sentinel Poller"
)

Set-StrictMode -Off
$ErrorActionPreference = "Stop"

function Write-Step { param($m) Write-Host "`n>>> $m" -ForegroundColor Cyan }
function Write-OK   { param($m) Write-Host "    [OK]   $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "    [WARN] $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "`n    [FAIL] $m" -ForegroundColor Red; exit 1 }

Clear-Host
Write-Host "================================================================" -ForegroundColor Magenta
Write-Host "  TK COMMS SENTINEL -- Installation Script" -ForegroundColor Magenta
Write-Host "================================================================" -ForegroundColor Magenta
Write-Host "  Install path : $InstallPath"
Write-Host "  IIS Site     : $SiteName  (port $Port)"
Write-Host "  App Pool     : $AppPool"
Write-Host "================================================================`n" -ForegroundColor Magenta

# ----------------------------------------------------------------
# STEP 1: Check prerequisites
# ----------------------------------------------------------------
Write-Step "Checking prerequisites"

# Node.js
try {
    $nodeVer = & node --version 2>$null
    if ($nodeVer -match 'v(\d+)' -and [int]$matches[1] -ge 20) {
        Write-OK "Node.js $nodeVer"
    } else {
        Write-Fail "Node.js 20+ required. Found: $nodeVer. Download: https://nodejs.org/en/download (LTS)"
    }
} catch {
    Write-Fail "Node.js not found. Download and install from: https://nodejs.org/en/download (LTS, 64-bit)"
}

# IIS
try {
    Import-Module WebAdministration -ErrorAction Stop
    Write-OK "IIS (WebAdministration module)"
} catch {
    Write-Fail "IIS WebAdministration module not found. Enable IIS via Server Manager first."
}

# iisnode
$iisnodeDll = "${env:ProgramFiles}\iisnode\iisnode.dll"
if (Test-Path $iisnodeDll) {
    Write-OK "iisnode"
} else {
    Write-Fail "iisnode not found at $iisnodeDll.`n         Download: https://github.com/azure/iisnode/releases (iisnode-full-v0.2.26-x64.msi)"
}

# URL Rewrite
$rewriteDll = "${env:WinDir}\System32\inetsrv\rewrite.dll"
if (Test-Path $rewriteDll) {
    Write-OK "URL Rewrite Module"
} else {
    Write-Fail "URL Rewrite Module not found.`n         Download: https://www.iis.net/downloads/microsoft/url-rewrite"
}

# ----------------------------------------------------------------
# STEP 2: Copy application files
# ----------------------------------------------------------------
Write-Step "Copying application files"

# Source: two levels up from this script (install\ -> root)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceDir  = Split-Path -Parent $scriptDir

if (-not (Test-Path "$sourceDir\backend\server.js")) {
    Write-Fail "Cannot find backend\server.js in $sourceDir`n         Make sure you are running install.ps1 from inside the package."
}

if (Test-Path $InstallPath) {
    Write-Warn "Directory $InstallPath already exists."
    $ans = Read-Host "         Overwrite existing installation? (y/N)"
    if ($ans.Trim().ToLower() -ne 'y') { Write-Fail "Installation cancelled by user." }
    Remove-Item $InstallPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
Write-Host "    Copying files..." -ForegroundColor Gray

Copy-Item "$sourceDir\backend"  "$InstallPath\backend"  -Recurse -Force
Copy-Item "$sourceDir\frontend" "$InstallPath\frontend" -Recurse -Force

# Ensure writable subdirectories exist
@("db","logs","certs","iisnode-logs") | ForEach-Object {
    New-Item -ItemType Directory -Force -Path "$InstallPath\backend\$_" | Out-Null
}

Write-OK "Files copied to $InstallPath"

# ----------------------------------------------------------------
# STEP 3: Configure .env
# ----------------------------------------------------------------
Write-Step "Setting up .env configuration"

$envDest    = "$InstallPath\backend\.env"
$envExample = "$InstallPath\backend\.env.example"

if (-not (Test-Path $envDest)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envDest
        Write-OK "Created .env from template"
    } else {
        Write-Warn ".env.example not found -- you must create $envDest manually"
    }
    Write-Warn "ACTION REQUIRED: Edit $envDest before starting the application!"
} else {
    Write-OK ".env already exists -- not overwritten"
}

# ----------------------------------------------------------------
# STEP 4: Create IIS Application Pool
# ----------------------------------------------------------------
Write-Step "Creating IIS Application Pool: $AppPool"

if (Get-WebAppPool $AppPool -ErrorAction SilentlyContinue) {
    Write-Warn "App pool $AppPool already exists -- updating settings"
} else {
    New-WebAppPool -Name $AppPool | Out-Null
}

Set-ItemProperty "IIS:\AppPools\$AppPool" managedRuntimeVersion ""
Set-ItemProperty "IIS:\AppPools\$AppPool" managedPipelineMode    "Integrated"
Set-ItemProperty "IIS:\AppPools\$AppPool" -Name processModel.idleTimeout       -Value "00:00:00"
Set-ItemProperty "IIS:\AppPools\$AppPool" -Name recycling.periodicRestart.time -Value "00:00:00"

Write-OK "App pool ready (No Managed Code, Integrated pipeline, no idle timeout)"

# ----------------------------------------------------------------
# STEP 5: Create IIS Website
# ----------------------------------------------------------------
Write-Step "Creating IIS Website: $SiteName on port $Port"

$physPath = "$InstallPath\backend"

# Check port conflict
$conflict = Get-WebBinding | Where-Object { $_.bindingInformation -like "*:${Port}:*" }
if ($conflict) {
    Write-Warn "Port $Port is already bound to another site. Change the -Port parameter or remove the conflict."
}

if (Get-Website $SiteName -ErrorAction SilentlyContinue) {
    Write-Warn "Site $SiteName exists -- updating physical path"
    Set-ItemProperty "IIS:\Sites\$SiteName" physicalPath $physPath
} else {
    New-Website -Name $SiteName -Port $Port -PhysicalPath $physPath -ApplicationPool $AppPool | Out-Null
}

Write-OK "IIS site configured (port $Port -> $physPath)"

# ----------------------------------------------------------------
# STEP 6: Set file permissions
# ----------------------------------------------------------------
Write-Step "Setting NTFS permissions for IIS_IUSRS"

# IIS_IUSRS needs full control on install dir (iisnode writes logs, DB is written by app)
$acl  = Get-Acl $InstallPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "IIS_IUSRS", "Modify,ReadAndExecute,ListDirectory,Read,Write",
    "ContainerInherit,ObjectInherit", "None", "Allow"
)
$acl.SetAccessRule($rule)
Set-Acl $InstallPath $acl
Write-OK "IIS_IUSRS: Modify on $InstallPath (recursive)"

# ----------------------------------------------------------------
# STEP 7: Create Scheduled Task (Poller)
# ----------------------------------------------------------------
Write-Step "Creating Scheduled Task: $TaskName"

$nodePath = (Get-Command node).Source
$pollerJs = "$InstallPath\backend\poller-service.js"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Warn "Task '$TaskName' exists -- replacing"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action    = New-ScheduledTaskAction -Execute "`"$nodePath`"" -Argument "`"$pollerJs`"" -WorkingDirectory "$InstallPath\backend"
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-OK "Scheduled task created (runs as SYSTEM, starts at boot)"

# ----------------------------------------------------------------
# STEP 8: Firewall rule
# ----------------------------------------------------------------
Write-Step "Opening Windows Firewall port $Port"

$fwName = "TK Comms Sentinel (TCP $Port)"
if (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue) {
    Write-OK "Firewall rule already exists"
} else {
    New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Protocol TCP `
        -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Write-OK "Firewall rule created for inbound TCP $Port"
}

# ----------------------------------------------------------------
# STEP 9: Start services
# ----------------------------------------------------------------
Write-Step "Starting services"

Start-WebAppPool -Name $AppPool
Start-Sleep -Seconds 2
Write-OK "App pool $AppPool started"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-OK "Poller task started"

# ----------------------------------------------------------------
# DONE
# ----------------------------------------------------------------
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  App URL   : http://localhost:$Port" -ForegroundColor Yellow
Write-Host "  Install   : $InstallPath" -ForegroundColor Gray
Write-Host ""
Write-Host "  MANDATORY NEXT STEPS:" -ForegroundColor Cyan
Write-Host "  1. Edit configuration:"
Write-Host "     notepad `"$InstallPath\backend\.env`""
Write-Host ""
Write-Host "  2. Set admin password (run in PowerShell):"
Write-Host "     node `"$InstallPath\backend\scripts\set-local-password.js`" admin"
Write-Host ""
Write-Host "  3. Restart the app pool after editing .env:"
Write-Host "     Restart-WebAppPool -Name $AppPool"
Write-Host ""
Write-Host "  4. Open browser:"
Write-Host "     http://localhost:$Port"
Write-Host ""
Write-Host "  5. Log in with:  username = admin"
Write-Host "     (password = what you set in step 2)"
Write-Host ""
Write-Host "  OPTIONAL:"
Write-Host "  - Import devices via Admin > Import CSV"
Write-Host "    (use sample-devices.csv from the install package as a template)"
Write-Host "  - For AD/LDAP: place your CA cert in $InstallPath\backend\certs\"
Write-Host "    then fill in LDAP_* vars in .env"
Write-Host "================================================================" -ForegroundColor Green
