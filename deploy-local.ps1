$ErrorActionPreference = 'Continue'
$PROD  = 'C:\inetpub\wwwroot\tkcommssentinel'
$SRC   = $PSScriptRoot
$ISCC  = "C:\Users\tulik\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
$GH    = "C:\Program Files\GitHub CLI\gh.exe"

Write-Host "`n=== TK Comms Sentinel - Full Deploy ===" -ForegroundColor Cyan

# 1. git pull
Write-Host "`n[1/7] git pull..." -ForegroundColor Yellow
Set-Location $SRC
& git pull
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed" -ForegroundColor Red; exit 1 }

$ver = (Get-Content "$SRC\VERSION" -Raw).Trim()
Write-Host "  Version: $ver" -ForegroundColor Cyan

# sync version into package.json files (so __APP_VERSION__ in the build is correct)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
foreach ($pkgFile in @("$SRC\backend\package.json", "$SRC\frontend\package.json")) {
    $j = [System.IO.File]::ReadAllText($pkgFile)
    $j = $j -replace '("version"\s*:\s*")[^"]+(")', "`${1}$ver`${2}"
    [System.IO.File]::WriteAllText($pkgFile, $j, $utf8NoBom)
}
Write-Host "  package.json versions synced to $ver" -ForegroundColor Green

# 2. npm install frontend
Write-Host "`n[2/7] npm install (frontend)..." -ForegroundColor Yellow
Set-Location "$SRC\frontend"
& npm install --prefer-offline 2>&1 | Where-Object { $_ -notmatch '^npm (warn|notice)' } | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }

# 3. build frontend
Write-Host "`n[3/7] npm run build..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "npm build failed" -ForegroundColor Red; exit 1 }
Set-Location $SRC

# 4. copy to IIS prod
Write-Host "`n[4/7] deploy to IIS ($PROD)..." -ForegroundColor Yellow
& robocopy "$SRC\frontend\dist" "$PROD\frontend\dist" /MIR /NFL /NDL /NJS /NC /NS /NP
Write-Host "  frontend\dist OK" -ForegroundColor Green
# NOTE: backend\db\ holds both CODE (database.js, audit.js, schema.sql) and the
# LIVE DATA FILE (netmonitor.db + WAL/SHM + backups). Excluding the whole "db"
# directory here used to silently block every code change under backend\db\ from
# ever reaching production (found 2026-09-16: hostname_cache/audit migrations
# never deployed because of this). Only the data files are excluded now -- the
# directory itself is no longer skipped.
& robocopy "$SRC\backend" "$PROD\backend" /MIR /XD node_modules certs logs iisnode-logs `
    /XF .env "netmonitor.db*" `
    /NFL /NDL /NJS /NC /NS /NP
Write-Host "  backend OK" -ForegroundColor Green
Copy-Item "$SRC\VERSION" "$PROD\VERSION" -Force
Write-Host "  VERSION -> $ver OK" -ForegroundColor Green

Set-Location "$PROD\backend"
& npm install --omit=dev --prefer-offline 2>&1 | Where-Object { $_ -notmatch '^npm (warn|notice)' } | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
Set-Location $SRC

Import-Module WebAdministration -ErrorAction SilentlyContinue
Stop-WebAppPool 'tkcommssentinel'
Start-Sleep -Seconds 2
Start-WebAppPool 'tkcommssentinel'
Write-Host "  App Pool restarted OK" -ForegroundColor Green

# 5. prepare package\versions\{ver} for Inno Setup
Write-Host "`n[5/7] preparing package\versions\$ver..." -ForegroundColor Yellow
$pkgVer     = "$SRC\package\versions\$ver"
# Sort by version, not by name: as text "1.3.10" sorts before "1.3.9", so a name sort
# would clone an older version as the base once the patch number reaches two digits.
$pkgVerPrev = (Get-ChildItem "$SRC\package\versions" -Directory |
    Sort-Object { $v = $null; if ([version]::TryParse($_.Name, [ref]$v)) { $v } else { [version]'0.0' } } |
    Select-Object -Last 1).FullName

if (-not (Test-Path $pkgVer)) {
    if ($pkgVerPrev -and $pkgVerPrev -ne $pkgVer) {
        Write-Host "  cloning $([System.IO.Path]::GetFileName($pkgVerPrev)) -> $ver (inherits node_modules)..."
        & robocopy $pkgVerPrev $pkgVer /MIR /NFL /NDL /NJS /NC /NS /NP | Out-Null
    } else {
        New-Item -ItemType Directory -Path $pkgVer | Out-Null
    }
}

# overwrite backend JS (skip node_modules; keep backend\db\ code but never
# ship any stray data file that might exist there in a dev checkout)
& robocopy "$SRC\backend" "$pkgVer\backend" /MIR `
    /XD node_modules `
    /XF .env "netmonitor.db*" "*.db" "*.db-shm" "*.db-wal" "*.db.bak*" "*.key" "*.pem" "*.pfx" `
    /NFL /NDL /NJS /NC /NS /NP | Out-Null

# if backend packages changed, reinstall in package
$pkgJson    = "$pkgVer\backend\package.json"
$pkgJsonSrc = "$SRC\backend\package.json"
$pkgNM      = "$pkgVer\backend\node_modules"
if (-not (Test-Path $pkgNM) -or ((Get-FileHash $pkgJson).Hash -ne (Get-FileHash $pkgJsonSrc).Hash)) {
    Write-Host "  npm install --omit=dev in package backend..."
    $savedLoc = Get-Location
    Set-Location "$pkgVer\backend"
    & "$SRC\package\node\node.exe" "$SRC\package\node\node_modules\npm\bin\npm-cli.js" install --omit=dev --prefer-offline 2>&1 | Where-Object { $_ -notmatch '^npm (warn|notice)' } | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
    Set-Location $savedLoc
}

# overwrite frontend dist
if (-not (Test-Path "$pkgVer\frontend")) { New-Item -ItemType Directory -Path "$pkgVer\frontend" | Out-Null }
& robocopy "$SRC\frontend\dist" "$pkgVer\frontend\dist" /MIR /NFL /NDL /NJS /NC /NS /NP | Out-Null

Write-Host "  package\versions\$ver OK" -ForegroundColor Green

# Sync installer\scripts\ (canonical, git-tracked) -> package\installer\scripts\
# (what TKCommsSentinel.iss actually bundles via {#PackageDir}\installer\*).
# These two folders are NOT the same directory and nothing else here kept
# them in sync -- a script added/edited only under installer\scripts\ would
# silently never reach a built installer. Same class of bug as the
# backend\db\ exclusion fixed above: fix at the source, not by remembering
# to run a separate step by hand.
& robocopy "$SRC\installer\scripts" "$SRC\package\installer\scripts" /MIR /NFL /NDL /NJS /NC /NS /NP | Out-Null
Write-Host "  package\installer\scripts synced from installer\scripts OK" -ForegroundColor Green

# build EXE installer
$outDir = "$SRC\dist-pkg"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
& $ISCC "/DMyAppVersion=$ver" "$SRC\installer\TKCommsSentinel.iss"
if ($LASTEXITCODE -ne 0) { Write-Host "Inno Setup build failed" -ForegroundColor Red; exit 1 }

$exePath = "$outDir\TKCommsSentinel-Setup-$ver.exe"
Write-Host "  EXE: $exePath" -ForegroundColor Green

# Extra copy named "latest" so releases/latest/download/TKCommsSentinel-Setup-latest.exe
# always points at the newest build without editing the website on every release.
$exeLatestPath = "$outDir\TKCommsSentinel-Setup-latest.exe"
Copy-Item $exePath $exeLatestPath -Force

# 6. SHA256 + GitHub Release
Write-Host "`n[6/7] publishing GitHub Release v$ver..." -ForegroundColor Yellow
$sha256 = (Get-FileHash $exePath -Algorithm SHA256).Hash.ToLower()
Write-Host "  SHA256: $sha256"

# Delete existing release if exists (re-release same version)
& $GH release delete "v$ver" --yes 2>$null

# Cut just this version's section out of the CHANGELOG to use as the release body.
# The pattern must be built before -replace sees it: -replace binds tighter than string
# concatenation, so an inline '...' + $ver + '...' passes only the first fragment as the
# pattern and the cut silently does nothing -- every release up to 1.3.8 shipped with the
# entire changelog as its body. Read as UTF-8 explicitly as well, or Get-Content assumes
# ANSI for this BOM-less file and turns every em-dash into mojibake.
$changelog   = [System.IO.File]::ReadAllText("$SRC\CHANGELOG.md", [System.Text.Encoding]::UTF8)
$sectionOnly = '(?s)(## \[' + [regex]::Escape($ver) + '\].*?)(## \[.*)$'
$notes = ($changelog -replace '(?s)^.*?## \[', '## [') -replace $sectionOnly, '$1'
$notesFile = "$env:TEMP\release-notes-$ver.md"
[System.IO.File]::WriteAllText($notesFile, $notes, $utf8NoBom)

& $GH release create "v$ver" $exePath $exeLatestPath `
    --title "TK Comms Sentinel v$ver" `
    --notes-file $notesFile `
    --latest
if ($LASTEXITCODE -ne 0) { Write-Host "GitHub release failed" -ForegroundColor Red; exit 1 }
Write-Host "  GitHub Release v$ver published OK" -ForegroundColor Green

# 7. update docs/latest.json + website + push
Write-Host "`n[7/7] updating website (docs/latest.json)..." -ForegroundColor Yellow
$today = (Get-Date -Format "yyyy-MM-dd")
$latestJson = @{
    version     = $ver
    date        = $today
    notes       = "See CHANGELOG for details"
    downloadUrl = "https://github.com/Tulik2323/tk-comms-sentinel/releases/latest/download/TKCommsSentinel-Setup-latest.exe"
    sha256      = $sha256
} | ConvertTo-Json -Depth 2
$latestJson | Set-Content "$SRC\docs\latest.json" -Encoding UTF8
Write-Host "  docs/latest.json updated" -ForegroundColor Green

# Update version chip in HTML pages
foreach ($htmlFile in @("$SRC\docs\index.html", "$SRC\docs\index.en.html")) {
    if (Test-Path $htmlFile) {
        $html = Get-Content $htmlFile -Raw -Encoding UTF8
        # replace ONLY the version chip in the download section (not history table)
        $html = $html -replace '(?<=VERSION <b>)\d+\.\d+\.\d+(?=</b>)', $ver
        # SHA256
        $html = $html -replace '[0-9a-f]{64}', $sha256
        $html | Set-Content $htmlFile -Encoding UTF8
        Write-Host "  $([System.IO.Path]::GetFileName($htmlFile)) updated" -ForegroundColor Green
    }
}

& git add "docs/latest.json" "docs/index.html" "docs/index.en.html"
& git commit -m "docs: bump website to v$ver [skip ci]"
& git push origin main
Write-Host "  docs pushed to GitHub Pages OK" -ForegroundColor Green

# restart poller scheduled task
$pollerTask = Get-ScheduledTask "NetMonitor Poller" -ErrorAction SilentlyContinue
if ($pollerTask) {
    Stop-ScheduledTask "NetMonitor Poller" -ErrorAction SilentlyContinue
    Start-Sleep 2
    Start-ScheduledTask "NetMonitor Poller"
    Write-Host "  Poller restarted OK" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Scheduled Task 'NetMonitor Poller' not found" -ForegroundColor Yellow
}

Write-Host "`n=== Full Deploy complete: v$ver ===" -ForegroundColor Cyan
Write-Host "  IIS:     updated + app pool restarted" -ForegroundColor White
Write-Host "  EXE:     $exePath" -ForegroundColor White
Write-Host "  Release: https://github.com/Tulik2323/tk-comms-sentinel/releases/tag/v$ver" -ForegroundColor White
Write-Host "  Website: https://tulik2323.github.io/tk-comms-sentinel/" -ForegroundColor White
