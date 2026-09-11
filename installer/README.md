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

## Build the distributable package (on the build machine)

One-time: fetch the vendored binaries into `vendor\` (portable Node 24 from
nodejs.org, NSSM from nssm.cc) — these are gitignored and never committed.
Then assemble a self-contained package:

```powershell
& .\installer\build-package.ps1        # -> .\package  (this folder is the install root)
```

`build-package.ps1` copies the backend, the built `frontend\dist`, the
portable Node, `nssm.exe`, and the installer scripts into `package\`, then runs
`npm install --omit=dev` with the portable Node so `backend\node_modules` is
baked in. **The result needs no internet on the target.** Copy `package\` to
the target server and use its folder as `<InstallRoot>`.

## Bring-up on a clean test server (before the EXE exists)

The package already contains `node\`, `tools\nssm.exe`, `backend\` (with
`node_modules`), `frontend\dist\`, and `installer\scripts\` — nothing to
download or `npm install` on the target. Run elevated:

```powershell
$Root = 'C:\TKCS\package'   # = the extracted package folder (the install root)

# 1. Generate the self-signed cert (writes data\certs\pfx-info.env itself)
& "$Root\installer\scripts\new-selfsigned-cert.ps1" -OutDir "$Root\data\certs"

# 2. Write backend\.env, reading the cert credentials from that file
#    (random JWT secrets; LDAP/SMTP left empty for local auth)
& "$Root\installer\scripts\write-env.ps1" -Root $Root -HttpsPort 9443

# 3. Register + start the services
& "$Root\installer\scripts\svc-install.ps1" -InstallRoot $Root -Start

# 4. Open the firewall port
& "$Root\installer\scripts\open-firewall.ps1" -Port 9443

# 5. Seed the first admin (interactive)
& "$Root\node\node.exe" "$Root\backend\scripts\seed-admin.js"
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

**Verified on a clean test server (SRV-APPS, 2026-09-11):** full install --
cert, `.env`, both NSSM services, firewall rule, seeded admin -- then logged
into the UI over `https://<server>:9443` in a browser. Two bugs were found
and fixed during that run: `server.js` loaded `.env` relative to the process
working directory (broke under NSSM, since fixed to load by `__dirname`),
and the fragile PFX-credential capture described above (now a file, per
step 1/2 above).

Verify: `https://<server>:9443/api/health` returns `{"status":"ok",...}`.

## Notes

- `backend\web.config` is **IIS/iisnode legacy** and is unused in the
  standalone build. It is kept only for reference and is not deployed.
- Still to come: the Inno Setup EXE wizard, the versioned/updater layout, and
  the online/offline update feed.
