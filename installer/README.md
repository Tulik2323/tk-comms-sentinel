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
- `.env` lives in `data\`, not `backend\` — see "Versioned install layout"
  below for why, and how the running service finds it.

## Versioned install layout

```
<InstallRoot>\
  current            -> directory junction to the active versions\x.y.z\
  versions\
    1.0.0\
      backend\         app code + node_modules
      frontend\dist\   built UI
    1.1.0\             (added by a later update; 1.0.0 stays on disk)
  node\                portable Node 24 runtime (shared across versions)
  tools\nssm.exe       (shared)
  installer\scripts\   (shared)
  data\                netmonitor.db, certs\, .env, logs\   <- an update never touches this
```

Services are configured once against the stable path `current\backend`
(`svc-install.ps1`'s default `-BackendDir`). An update copies the new
version into `versions\<new>\`, swaps the `current` junction, and restarts
the services — no service reconfiguration needed, and rollback is just
swapping the junction back.

**Finding `data\.env` regardless of the active version:** `svc-install.ps1`
sets `TKCS_DATA_DIR=<InstallRoot>\data` in each service's environment
(NSSM's `AppEnvironmentExtra`). `server.js` / `poller-service.js` load
`.env` from `TKCS_DATA_DIR` when it's set, falling back to their own
directory otherwise — so a pre-versioned flat install (like the original
SRV-APPS test, with `.env` inside `backend\`) keeps working unmodified.

## Scripts (`installer/scripts/`)

All are ASCII-only (Windows PowerShell 5.1 compatible) and must run elevated.

| Script | Purpose |
|---|---|
| `activate-version.ps1` | Create/repoint the `current` junction at a `versions\x.y.z\` folder. No `-Version` = highest version present. Used on first install and by `update.ps1`. |
| `new-selfsigned-cert.ps1` | Generate a self-signed `server.pfx`. Writes `<OutDir>\pfx-info.env` (`PFX_PATH=`/`PFX_PASSWORD=`) as the source of truth for other scripts. |
| `write-env.ps1` | Generate `data\.env`: HTTPS port, TLS cert (read from `pfx-info.env`), DB path, random JWT secrets. Refuses to overwrite an existing `.env` without `-Force`, and refuses to write a cert path with no password. |
| `svc-install.ps1` | Register/reconfigure the `TKCommsSentinel` (web) and `TKCommsSentinelPoller` services. Idempotent; auto-start; restart-on-crash; graceful Ctrl-C stop; sets `TKCS_DATA_DIR`. `-Start` to start them. |
| `svc-uninstall.ps1` | Stop and remove both services. Leaves `data\` untouched. |
| `open-firewall.ps1` | Inbound Allow rule for TCP `HTTPS_PORT`. `-Remove` to delete it. |
| `update.ps1` | Apply a version-only package: copy in, swap `current`, restart, health-check, **auto-rollback on failure**. See "Updating an install" below. |

## Build the distributable package (on the build machine)

One-time: fetch the vendored binaries into `vendor\` (portable Node 24 from
nodejs.org, NSSM from nssm.cc) — these are gitignored and never committed.
Then assemble a package:

```powershell
& .\installer\build-package.ps1                  # full package -> .\package
& .\installer\build-package.ps1 -VersionOnly     # update-only package -> .\package (just versions\<version>\)
```

The full package (default) copies the backend, built `frontend\dist`, the
portable Node, `nssm.exe`, and the installer scripts into
`package\versions\<version>\` plus the shared `node\`/`tools\`/`installer\`/
`data\`, then runs `npm install --omit=dev` with the portable Node so
`node_modules` is baked in. **The result needs no internet on the target.**
`-VersionOnly` skips the shared pieces (node/nssm/data) and produces just
`versions\<version>\` — much smaller (~18 MB vs ~119 MB) — for `update.ps1`
to apply to an *existing* install.

No `current` junction is created at build time (junctions do not survive
being zipped); `activate-version.ps1` creates it after extraction, below.

## First install on a clean server

Extract the full package, then run elevated:

```powershell
$Root = 'C:\TKCS\package'   # = the extracted package folder (the install root)

# 0. Point "current" at the one version the full package ships
& "$Root\installer\scripts\activate-version.ps1" -InstallRoot $Root

# 1. Generate the self-signed cert (writes data\certs\pfx-info.env itself)
& "$Root\installer\scripts\new-selfsigned-cert.ps1" -OutDir "$Root\data\certs"

# 2. Write data\.env, reading the cert credentials from that file
#    (random JWT secrets; LDAP/SMTP left empty for local auth)
& "$Root\installer\scripts\write-env.ps1" -Root $Root -HttpsPort 9443

# 3. Register + start the services (AppDirectory = current\backend)
& "$Root\installer\scripts\svc-install.ps1" -InstallRoot $Root -Start

# 4. Open the firewall port
& "$Root\installer\scripts\open-firewall.ps1" -Port 9443

# 5. Seed the first admin. The password needs at least 12 characters (mixing lower
#    case, upper case, digits and symbols unless it is 16 or longer), at most 72
#    bytes, and must not contain the user name; the script refuses a weaker one.
#    The user name may contain English letters, digits and . _ @ -
& "$Root\node\node.exe" "$Root\current\backend\scripts\seed-admin.js" <username> <password> admin
```

Step 2 reads `PFX_PATH`/`PFX_PASSWORD` from `data\certs\pfx-info.env` by
default (`write-env.ps1 -PfxInfoFile` to point elsewhere). **Do not** capture
step 1's console output into a variable and pass it as `-PfxPath`/
`-PfxPassword` by hand -- that path was tried and failed in the field
(`$cert = & new-selfsigned-cert.ps1 ...` silently produced an empty password,
which reached a running service before being noticed). `write-env.ps1` also
refuses to write a `.env` with a `PfxPath` set but no password, so this class
of mistake fails loudly instead of producing a service that silently falls
back to plain HTTP.

`write-env.ps1` refuses to overwrite an existing `.env` (use `-Force`), so it
never silently rotates the JWT secret. LDAP/SMTP are configured later in
Admin > Settings or by editing `.env`.

Verify: `https://<server>:9443/api/health` returns `{"status":"ok",...}`.

**Verified on a clean test server (SRV-APPS, 2026-09-11), pre-versioned flat
layout:** full install -- cert, `.env`, both NSSM services, firewall rule,
seeded admin -- then logged into the UI over `https://<server>:9443` in a
browser. Two bugs were found and fixed during that run: `server.js` loaded
`.env` relative to the process working directory (broke under NSSM, fixed to
load from a fixed location), and the fragile PFX-credential capture described
above (now a file). **The versioned layout above (`current`/`versions\`,
`activate-version.ps1`, `update.ps1`) has been unit-tested locally
(junction creation/repoint/no-op, package structure) but not yet run
end-to-end with real services on a clean server -- do that next, the same
way the flat layout was validated.**

## Updating an install

```powershell
& "<InstallRoot>\installer\scripts\update.ps1" -SourcePackageDir 'C:\path\to\extracted-version-only-package'
```

`update.ps1` copies the new `versions\<version>\` in, stops both services,
repoints `current`, starts both services, then health-checks
`https://localhost:<HTTPS_PORT>/api/health` for up to `-HealthTimeoutSec`
(default 30s). If the health check fails, it **automatically rolls back**:
repoints `current` to the previous version and restarts — the previous
version's files were never touched, so this is a clean revert, not a
reinstall. Pass `-NoRollback` to leave the failed version active for manual
investigation instead.

The health check uses a raw `TcpClient`+`SslStream` (with a permissive
certificate callback), not `Invoke-WebRequest`: in testing on SRV-APPS,
`Invoke-WebRequest`/`ServicePointManager` in Windows PowerShell 5.1 failed
("underlying connection was closed") against this exact server/cert even
though a real browser connected fine. The lower-level socket approach
sidesteps that stack entirely.

Old version folders are **not** pruned automatically -- they stay on disk so
a rollback is always possible. Pruning is a manual/future step.

## Notes

- `backend\web.config` is **IIS/iisnode legacy** and is unused in the
  standalone build. It is kept only for reference and is not deployed.
- Still to come: the Inno Setup EXE wizard (to wrap first-install end to
  end) and the online/offline update feed (a manifest `update.ps1`'s caller
  can check against).
