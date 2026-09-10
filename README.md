# TK Comms Sentinel — Installer Workspace

Build workspace for packaging **TK Comms Sentinel** as a standalone, one-click
**Windows Server installer** (EXE) for delivery to customers — no IIS, no manual
scripts.

## Provenance

Source copied on **2026-09-10** from the live deployment at
`C:\inetpub\wwwroot\tkcommssentinel` (read-only copy — the live deployment was
not modified).

**Deliberately excluded** from the copy (not application source):
`node_modules/`, live DB data (`netmonitor.db*`), `certs/`, `logs/`,
`iisnode-logs/`, `frontend/dist/`, `.env` (secrets), plus stray non-source
files (`1.txt`, `Capture.PNG`). The DB **source** — `backend/db/database.js`,
`backend/db/audit.js`, `backend/db/schema.sql` — **is** tracked.

## Target architecture (standalone)

1. **No IIS.** `server.js` listens directly over HTTPS (loads its own cert).
2. **Portable Node.js** bundled in the package — no prerequisite install.
3. **backend + poller run as two Windows Services** (via NSSM).
4. **Inno Setup EXE** wizard: copies files, creates services, opens the
   firewall port, generates a self-signed cert, seeds the first admin user.
5. **Versioned install layout** (`current` junction + `versions\x.y.z\`) for
   atomic online/offline updates without reinstalling.

## Layout

- `backend/` — Node/Express API (`server.js`), poller, routes, services, DB code.
- `frontend/` — React app (Vite); built to `dist/` at package time.
- `install/` — legacy `install.ps1` (reference; superseded by the EXE installer).

## Status

Workspace bootstrapped. Next: standalone conversion (detach from IIS, direct
HTTPS listener, backend + poller as Windows Services).
