$ErrorActionPreference = 'Continue'
$PROD = 'C:\inetpub\wwwroot\tkcommssentinel'
$SRC  = $PSScriptRoot

Write-Host "`n=== TK Comms Sentinel - Local Deploy ===" -ForegroundColor Cyan

# 1. git pull
Write-Host "`n[1/5] git pull..." -ForegroundColor Yellow
Set-Location $SRC
& git pull
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed" -ForegroundColor Red; exit 1 }

# 2. npm install (fast if nothing changed)
Write-Host "`n[2/5] npm install (frontend)..." -ForegroundColor Yellow
Set-Location "$SRC\frontend"
& npm install --prefer-offline 2>&1 | Select-String -NotMatch '^npm warn' | ForEach-Object { Write-Host $_ }

# 3. build frontend
Write-Host "`n[3/5] npm run build..." -ForegroundColor Yellow
Set-Location "$SRC\frontend"
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "npm build failed" -ForegroundColor Red; exit 1 }
Set-Location $SRC

# 4. copy files to prod
Write-Host "`n[4/5] copying to $PROD..." -ForegroundColor Yellow

# frontend dist only
& robocopy "$SRC\frontend\dist" "$PROD\frontend\dist" /MIR /NFL /NDL /NJS /NC /NS /NP
Write-Host "  frontend\dist OK" -ForegroundColor Green

# backend - skip data dirs and sensitive files
& robocopy "$SRC\backend" "$PROD\backend" /MIR /XD node_modules db certs logs iisnode-logs /XF .env /NFL /NDL /NJS /NC /NS /NP
Write-Host "  backend OK" -ForegroundColor Green

# VERSION
Copy-Item "$SRC\VERSION" "$PROD\VERSION" -Force
$ver = Get-Content "$SRC\VERSION" -Raw
$ver = $ver.Trim()
Write-Host "  VERSION -> $ver" -ForegroundColor Green

# 5. backend npm install in prod (fast if nothing changed)
Write-Host "`n  npm install --production in PROD backend..." -ForegroundColor DarkGray
Set-Location "$PROD\backend"
& npm install --omit=dev --prefer-offline 2>&1 | Where-Object { $_ -notmatch '^npm warn' } | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
Set-Location $SRC

# 6. restart app pool
Write-Host "`n[5/5] restarting app pool tkcommssentinel..." -ForegroundColor Yellow
Import-Module WebAdministration -ErrorAction SilentlyContinue
Stop-WebAppPool 'tkcommssentinel'
Start-Sleep -Seconds 2
Start-WebAppPool 'tkcommssentinel'
Write-Host "  App Pool restarted OK" -ForegroundColor Green

Write-Host "`n=== Deploy complete: v$ver ===" -ForegroundColor Cyan
