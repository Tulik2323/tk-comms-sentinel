# Changelog

All notable changes to TK Comms Sentinel are documented here.

## [1.3.5] — 2026-09-16

### Added
- **Hostname resolution (reverse DNS) for endpoints** — every IP address shown for an
  endpoint (port "connected endpoints" table, endpoint search, global header search) now
  also shows the computer name, when one is available via reverse DNS (PTR record). Relies
  on the DHCP server registering dynamic DNS updates (the common default in AD-integrated
  environments) — no new credentials or external service required.
  - New `hostname_cache` table (`backend/db/database.js`) caches PTR lookups for 6 hours.
  - New `backend/services/hostnames.js`: `refreshStaleHostnames()` runs every 5 minutes from
    the poller process (`backend/services/poller.js`), resolving IPs seen in `mac_entries`
    that aren't cached or are stale; `attachHostnames()` is a synchronous cache-only lookup
    used by the API routes, so pages never wait on live DNS.
  - Wired into `/api/devices/endpoint-search`, `/api/devices/:id/port-endpoints/:ifIndex`,
    and `/api/search`.
  - If your DHCP does not update DNS, this will show nothing — ask if you want direct
    DHCP-lease-based resolution instead (option B from the earlier discussion).

## [1.3.4] — 2026-09-16

### Fixed
- **Audit page still showing Hebrew in English mode** — audit log messages (`logAudit()`
  calls across auth/admin/devices/tools/updates/poller) were generated and stored as raw
  Hebrew sentences in `audit_log.message`. Added `msg_key`/`msg_params` columns; every
  `logAudit()` call site now passes a translation key + structured params, and the frontend
  (`frontend/src/lib/auditFormat.js`) rebuilds the message in the active language. Also
  translated the path-outage alert (`metric = 'path'`) the same way in `alertFormat.js`.
- **Broken "latest" download link** — `docs/index.html`, `docs/index.en.html`, and
  `docs/latest.json` all pointed at
  `releases/latest/download/TKCommsSentinel-Setup-latest.exe`, but only an asset named
  `TKCommsSentinel-Setup-<version>.exe` was ever uploaded, so the link 404'd. `deploy-local.ps1`
  now also uploads a second copy of the installer named exactly `TKCommsSentinel-Setup-latest.exe`
  on every release, so the evergreen link always resolves.

## [1.3.3] — 2026-09-16

### Fixed
- **Full English translation coverage** — the v1.3.1/1.3.2 language switch only translated
  the sidebar; every page's body content (Dashboard widgets, Alerts, Devices, Device Detail,
  Port Changes, Watchdog, Trends, Audit, Topology, Map, Tools, Reports, Admin, License, Login)
  was still hardcoded Hebrew. Added ~250 translation keys and wired every page through `t()`.
- **Alert messages stored in Hebrew** — alert event messages were generated and saved in
  Hebrew in the database, so they showed in Hebrew even in English mode. The frontend now
  rebuilds the alert text client-side in the active language from the underlying metric/value/
  threshold/port fields (`frontend/src/lib/alertFormat.js`); the `/alerts/events` API now also
  returns `port_label` so port-specific alerts can be reworded.
- **Remaining hardcoded `direction`/`textAlign: 'right'`/`he-IL` locale calls** — replaced with
  logical CSS properties and locale-less `toLocaleString()` calls in Port Changes, Trends,
  Topology, and Device Detail pages so dates and layout follow the selected language.

## [1.3.2] — 2026-09-15

### Fixed
- **RTL/LTR layout switch** — removed hardcoded `direction: rtl` from CSS body; the
  `dir` attribute on `<html>` now controls layout direction. Switching to English moves
  the sidebar to the left and the whole app to LTR.
- **Sidebar border** — changed `border-left` to `border-inline-end` so the border always
  appears between the sidebar and the main content, regardless of layout direction.
- **Version chip position** — chip now uses `inset-inline-end` so it sits in the main
  content area (never over the sidebar) in both RTL and LTR modes.

## [1.3.1] — 2026-09-15

### Fixed
- **Language switch — full UI coverage** — all hardcoded Hebrew strings in Layout now go through `t()`:
  subtitle under logo, search placeholder, "no results" message, theme tooltip, role badge (Admin/Viewer),
  and all 4 license banners (trial, trial-expired, grace, expired)
- **Poller not running** — Scheduled Task "NetMonitor Poller" had no Repetition Interval (one-shot trigger).
  Fixed trigger to repeat every 1 minute; poller restarted. Traffic/bandwidth charts and alerts will
  resume populating within minutes of deploying this version.
- **deploy-local.ps1** — script now restarts the poller scheduled task after each IIS deploy, so
  the poller is always live after an upgrade.

## [1.3.0] — 2026-09-15

### Added
- **Port Watchdog page** — moved from a modal inside the Devices page to a standalone main-menu item (`/watchdog`)
  - Left panel: search + checkbox device list (select any number of switches) + Start/Stop button
  - Main area: only changed ports appear, in chronological detection order (newest first)
  - Each row: timestamp / device name / port name / direction (🔴 ירד / 🟢 עלה)
  - Browser desktop notification + Web Audio API beep on each change (down = low double tone, up = high single tone)
  - Session-only — no persistence, no storage; clears when you navigate away
  - Available to all authenticated users (not admin-only)

### Fixed
- **Language switch (Hebrew ↔ English)** — most nav items were hardcoded Hebrew strings not going through `t()`.
  All sidebar nav items now use the translation system, so switching language updates the entire menu.
  Added missing translation keys to both `he` and `en` sections in `i18n.js`:
  `port_changes`, `trends`, `audit`, `diagnostics`, `reports`, `license`, `watchdog`

### Deployment notes (PROD — run in second conversation)
1. `git pull` in `C:\dev\tkcs-installer`
2. `npm run build` in `frontend\`
3. Restart IIS app pool: `Stop-WebAppPool TKCommsSentinel; Start-WebAppPool TKCommsSentinel`
4. Verify poller is running: `sc query TKCSPoller` — if STOPPED, run `sc start TKCSPoller`
   (metrics data may be missing if poller stopped during v1.2.0 upgrade)

## [1.2.0] — 2026-09-14

### Added
- **7-day trial period** — fresh installations get a 7-day grace period without a license
  - Days 0–6: blue info banner shows remaining trial days
  - Day 7+: hard block — all API calls return 402, only the License page is accessible
  - Admins see a direct "Activate License" link; other users see "Contact your administrator"
- **License enforcement middleware** — backend now returns HTTP 402 for expired, trial-expired,
  and invalid license states on all authenticated API routes (auth, license, and health excluded)

## [1.1.0] — 2026-09-13

### Added
- **License management system** — ED25519 offline licensing (no internet required)
  - "רישוי" tab in Admin navigation shows the machine fingerprint code
  - Admin pastes a license key received from TK to activate
  - `tools/keygen/issue-license.js` — TK-side tool to generate signed license keys
- **License enforcement** — grace period (30 days default) after expiry, then UI block
  - Warning banner shown during grace period with days remaining
  - Hard UI block (redirect to /license) after grace period ends
  - Monitoring poller and alerts continue running regardless of license state
- **Version display fix** — corner chip now shows the real app version (`1.1.0`) instead of a raw build timestamp; build timestamp shown smaller alongside
- Machine fingerprint uses Windows `MachineGuid` (stable hardware ID) + hostname

### Changed
- `server.js` — added `/api/license` route
- `Layout.jsx` — license banner + nav item + version chip fix
- `api.js` — 402 interceptor redirects to /license page

## [1.0.0] — 2026-09-11

### Initial standalone release
- SNMP network monitoring (HPE Comware switches, ~30 devices)
- React frontend + Express backend as Windows Services (NSSM)
- HTTPS via self-signed PFX certificate
- AD/LDAP authentication + local admin + TOTP 2FA
- Versioned layout (`current` junction → `versions\x.y.z\`)
- Automated update + rollback (`update.ps1`)
- Inno Setup EXE installer with wizard UI and full branding
