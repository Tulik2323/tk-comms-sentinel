# TK Comms Sentinel — Installer

Turns the app into a standalone Windows Server install: **no IIS**, the Node
backend terminates TLS itself, and the backend + poller run as **Windows
services** (via [NSSM](https://nssm.cc/)).

## Standalone architecture

- `server.js` listens on **HTTPS directly** (`HTTPS_PORT`, default `9443`).
  It loads a certificate in one of two ways, checked in order:
  1. **PFX** (`TLS_PFX_PATH` + `TLS_PFX_PASSWORD`) — the self-signed cert the
     installer generates with `New-SelfSignedCertificate`.
  2. **PEM** (`TLS_CERT_PATH` + `TLS_KEY_PATH`) — a customer-supplied cert.

  With no cert configured it falls back to plain HTTP on `PORT` (dev only).
- `poller-service.js` is a separate long-running process (already was, to keep
  the polling loop off IIS worker recycling). It becomes its own service.
- Database: `node:sqlite` (built into Node 24 — no native addon, no build
  step). `DB_PATH` accepts an absolute path, so the DB can live in a shared
  `data\` folder that updates never touch.

## Scripts (`installer/scripts/`)

All are ASCII-only (Windows PowerShell 5.1 compatible) and must run elevated.

| Script | Purpose |
|---|---|
| `new-selfsigned-cert.ps1` | Generate a self-signed `server.pfx`. Prints `TLS_PFX_PATH=` and `TLS_PFX_PASSWORD=` for the installer to write into `.env`. |
| `svc-install.ps1` | Register/reconfigure the `TKCommsSentinel` (web) and `TKCommsSentinelPoller` services. Idempotent; auto-start; restart-on-crash; graceful Ctrl-C stop. `-Start` to start them. |
| `svc-uninstall.ps1` | Stop and remove both services. Leaves `data\` untouched. |
| `open-firewall.ps1` | Inbound Allow rule for TCP `HTTPS_PORT`. `-Remove` to delete it. |

## Target install layout (versioned — implemented in a later step)

```
<InstallRoot>\
  current   -> junction to the active version
  versions\<x.y.z>\   backend\ , frontend\dist\   (app code only)
  node\               portable Node 24 runtime (shared)
  tools\              nssm.exe
  data\               netmonitor.db, certs\, .env   (updates never touch this)
```

## Manual bring-up on a clean test server (before the EXE exists)

Prerequisites staged under `<InstallRoot>`: `backend\`, `frontend\dist\`
(build with `npm run build` in `frontend\`), `node\node.exe` (portable Node
24), `tools\nssm.exe`.

```powershell
$Root = 'C:\Program Files\TKCommsSentinel'   # example
# 1. Install backend dependencies with the portable Node's npm
& "$Root\node\npm.cmd" --prefix "$Root\backend" install --omit=dev

# 2. Generate the self-signed cert (capture the two printed lines)
& "$Root\installer\scripts\new-selfsigned-cert.ps1" -OutDir "$Root\data\certs"

# 3. Create $Root\backend\.env from .env.example, then set at least:
#      NODE_ENV=production
#      HTTPS_PORT=9443
#      TLS_PFX_PATH=<from step 2>   TLS_PFX_PASSWORD=<from step 2>
#      DB_PATH=<absolute path under data\>
#      JWT_SECRET / JWT_TEMP_SECRET = long random strings
#      APP_BASE_URL=https://<server>:9443

# 4. Register + start the services
& "$Root\installer\scripts\svc-install.ps1" -InstallRoot $Root -Start

# 5. Open the firewall port
& "$Root\installer\scripts\open-firewall.ps1" -Port 9443

# 6. Seed the first admin (interactive)
& "$Root\node\node.exe" "$Root\backend\scripts\seed-admin.js"
```

Verify: `https://<server>:9443/api/health` returns `{"status":"ok",...}`.

## Notes

- `backend\web.config` is **IIS/iisnode legacy** and is unused in the
  standalone build. It is kept only for reference and is not deployed.
- Still to come: the Inno Setup EXE wizard, the versioned/updater layout, and
  the online/offline update feed.
