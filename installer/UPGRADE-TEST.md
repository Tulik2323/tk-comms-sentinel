# Upgrade test — verifying `update.ps1` end to end

The installer and the updater were built and reviewed separately; this is the
procedure that proves they compose. Run it against a server that already has a
real install on it (an admin account created, a self-signed certificate
generated, the poller having written to the database) — an upgrade over a
pristine install proves much less, because the whole point is that
**`data\` survives untouched**.

Everything below assumes the default install root:

```
C:\Program Files\TKCommsSentinel
```

## What is being proven

| Claim | Evidence |
|---|---|
| The new version is activated | `VERSION` file and `/api/health` both report the new number |
| The junction swap happened | `current` points at `versions\<new>\` |
| Rollback is still possible | `versions\<old>\` is still on disk |
| The database survived | Same file, same creation time, existing admin can still log in |
| The certificate survived | `data\certs\*.pfx` hash unchanged |
| The configuration survived | `data\.env` hash unchanged |
| The services survived | Both services `Running`, and still pointed at `current\backend` |

## 0. Prerequisites

- The update package (`TKCommsSentinel-1.0.1-update.zip`, ~6 MB) copied to the
  server, e.g. `C:\Temp\`.
- An **elevated** PowerShell session (`update.ps1` stops and starts services).

Read the HTTPS port once — the rest of the procedure needs it:

```powershell
Select-String -Path "C:\Program Files\TKCommsSentinel\data\.env" -Pattern '^HTTPS_PORT='
```

## 1. Capture the baseline

Run this **before** touching anything and keep the output; step 3 compares
against it.

```powershell
$root = "C:\Program Files\TKCommsSentinel"
"VERSION : " + (Get-Content "$root\VERSION" -Raw).Trim()
"current -> " + (Get-Item "$root\current").Target
"versions: " + ((Get-ChildItem "$root\versions" -Directory).Name -join ', ')
Get-Service TKCommsSentinel, TKCommsSentinelPoller | Format-Table Name, Status -AutoSize
"env  : " + (Get-FileHash "$root\data\.env" -Algorithm SHA256).Hash
Get-ChildItem "$root\data\certs\*.pfx" | ForEach-Object {
  "cert : $($_.Name) $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
Get-Item "$root\data\netmonitor.db" | ForEach-Object {
  "db   : created $($_.CreationTime)  size $($_.Length)" }
```

And the running version, straight from the service. Note this goes through the
**bundled Node**, not `Invoke-WebRequest`: a hardened server's SChannel policy
can reject the connection even while the server is perfectly healthy — the
same reason `update.ps1` health-checks this way (see its `.DESCRIPTION`).

```powershell
$port = 9443
& "C:\Program Files\TKCommsSentinel\node\node.exe" -e "const https=require('https');https.get({hostname:'127.0.0.1',port:$port,path:'/api/health',rejectUnauthorized:false,timeout:5000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).on('error',e=>console.log('ERR '+e.message))"
```

Expect `"version":"1.0.0"`.

## 2. Apply the update

```powershell
Expand-Archive -Path "C:\Temp\TKCommsSentinel-1.0.1-update.zip" -DestinationPath "C:\Temp\tkcs-1.0.1" -Force
& "C:\Program Files\TKCommsSentinel\installer\scripts\update.ps1" -SourcePackageDir "C:\Temp\tkcs-1.0.1"
```

The script copies the version in, stops both services, repoints `current`,
starts them again, and polls `/api/health` for up to 30 seconds. If the health
check fails it repoints `current` back and restarts on the old version by
itself — a failure here should leave a **working 1.0.0**, not a broken server.
That outcome is a passing test of the rollback path, not a disaster; capture
the output either way.

## 3. Verify

Re-run **both** blocks from step 1 and compare:

- `VERSION` and `/api/health` → `1.0.1`
- `current` → `...\versions\1.0.1`
- `versions` → contains **both** `1.0.0` and `1.0.1`
- both services `Running`
- `.env` hash, `.pfx` hash, DB creation time → **identical to the baseline**

Then the part no script can check — open the UI in a browser and **log in with
the existing admin account**. The database, the session secret in `.env` and
the certificate all have to still line up for that to work; it is the single
strongest end-to-end signal.

## 4. Rollback drill (optional, recommended)

Auto-rollback only fires when the health check fails, so it is worth
provoking once rather than trusting it on the day it matters. Build a
deliberately broken version on the build machine:

> Run on 2026-09-12 against SRV-APPS (1.0.1 active). The drill passed:
> failure reported after the 30s timeout, `current` repointed to 1.0.1, both
> services running, `/api/health` back to 1.0.1 with an uptime consistent
> with a real restart, and a non-zero exit so automation sees the failure.
>
> It also justified the design after the fact. Starting the broken version,
> Windows reported the **web service as started within a second** while the
> Node process inside it was crash-looping under NSSM; only the poller
> produced "waiting for service" warnings. A check on service *status* would
> have passed this drill and left a dead server behind. Service status means
> "the process was launched", never "the application works" -- which is why
> the gate here is `/api/health` and must stay that way.

```powershell
& C:\dev\tkcs-installer\installer\build-package.ps1 -VersionOnly -VersionOverride '1.0.2-broken' -OutDir 'C:\dev\tkcs-installer\package-broken'
Add-Content 'C:\dev\tkcs-installer\package-broken\versions\1.0.2-broken\backend\server.js' "`r`nthrow new Error('deliberate failure for rollback drill');"
```

Zip it the same way, apply it with the same command, and confirm that
`update.ps1` reports the failed health check, puts `current` back on `1.0.1`,
and that the app is serving again on `1.0.1` afterwards.

## Cleanup

Old version folders are intentionally **not** pruned — that keeps a rollback
possible. Remove a version folder only once you are sure you will never roll
back to it, and never remove the one `current` points at.
