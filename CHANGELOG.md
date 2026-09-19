# Changelog

All notable changes to TK Comms Sentinel are documented here.

## [1.4.0] — 2026-09-19

### Added
- **Physical switch count on the Dashboard** — a new **Physical Switches** card next to
  "Total Devices". The 99 in "Total Devices" is the number of monitored IP addresses, but a
  single address is often a whole stack of 2–10 switches, so it understated the real
  equipment. The card now shows the number of physical switches (213 on the live system,
  behind 99 addresses), with a note under it — "across 99 IP addresses", or "N addresses
  without data" when some cannot be measured. The count comes from the device itself: in the
  ENTITY-MIB every member of a stack appears as its own `chassis` entry
  (`entPhysicalClass = 3`), so the poller counts those and stores the result in the new
  `devices.stack_members` column. It is re-measured once an hour (the first reading is taken
  in the first poll after an update, so the card fills in within minutes) and a failed or
  empty reading never overwrites a known value. Verified on HPE Comware (IRF), Aruba
  ProCurve 2930F/2930M and Aruba CX 6300M. Two gateway addresses that return no ENTITY-MIB
  data are left out of the total and shown as "without data" rather than guessed as switches.

### Fixed
- **HPE switches were classified as Computers in Inventory** — HPE registers its switches
  and its servers/PCs under the same `Hewlett Packard Enterprise` vendor name, so the vendor
  lookup put every HPE switch address in Computers. An endpoint whose IP address belongs to
  a device this system monitors is now Network infrastructure. On the live data 190 rows
  moved from Computers to Network (Network 58 → 247). A VLAN's "Incl. identified" override
  still takes precedence.

## [1.3.12] — 2026-09-18

### Added
- **Custom Inventory categories** — besides the built-in ones (Computers, Printers,
  Cameras, ...), an administrator can now create categories of their own, for example
  "Radiology & Cardiology" for VLANs 441/442. Open a VLAN's category dropdown on the VLANs
  tab and choose **➕ New category...**: type a name and pick an icon from a list (the
  colour is assigned automatically). The new category is selected on that VLAN straight
  away, gets its own summary card at the top of the page, and works in the filter and the
  table like any built-in one. A "Your categories" strip on the VLANs tab lets an admin
  rename a category, change its icon, or delete it. Deleting releases every VLAN that used
  it, and those devices return to their own automatic classification. The name is a single
  text shown the same way in Hebrew and English. Categories are validated server-side
  (unique name, up to 32 characters, up to 30 categories, icon from the list), changing
  them is admin-only, and every create / rename / delete is written to the audit log.
- **Per-VLAN "Incl. identified" checkbox** — until now a VLAN's category applied only to
  devices still classed as Unknown, which left the already-identified devices out of a
  medical-equipment VLAN (VLAN 441 holds 13 devices the vendor lookup calls "Computers").
  Ticking the box makes the VLAN's category apply to every device on it. It is off by
  default, so a general VLAN such as 60 keeps its cameras and printers in their own
  categories.

### Changed
- The summary cards now come from the server's category list, so user-defined categories
  appear in it; the order is built-in categories, then custom ones, then Unknown last.

## [1.3.11] — 2026-09-18

### Added
- **`backend/scripts/check-schema.js`** — a fixed, read-only tool for inspecting the
  database structure: `node check-schema.js` lists the tables, and
  `node check-schema.js <table>` shows a table's columns and row count. It finds the
  database the same way the server does (`.env` from `TKCS_DATA_DIR` or `backend\`, then
  `DB_PATH`), so it works on both installed and IIS deployments. The table name is
  checked against the real table list before any SQL runs.

### Fixed
- **The schema tool kept disappearing from the live server** — it had been created
  directly in the IIS folder rather than in the repo, and `deploy-local.ps1` mirrors
  `backend\` with `robocopy /MIR`, which deletes every file that is not in the repo. The
  1.3.9 deploy deleted it hours after it was created. It is now tracked, so every deploy
  puts it back.

## [1.3.10] — 2026-09-18

### Added
- **VLAN names in Inventory** — a new **VLANs** tab lists every VLAN the system sees on
  the network, with its device count, how many of those devices are still Unknown, and
  how many switch ports and switches carry it. An administrator can give each VLAN a
  name (e.g. 220 = Cameras, 443 = IT workstations) and optionally a category. VLANs
  are read straight from the equipment over SNMP, with no manual list: first the L3
  interface a device's ARP entry was learned on (`VLAN300`, `Vlan-interface1`,
  `DEFAULT_VLAN`, `bond100.60`), falling back to the access VLAN (PVID) of its switch
  port. The ARP VLAN wins because an IP phone sits on the voice VLAN while its port's
  PVID is the data VLAN behind it. On the live dataset 9,800 of 9,844 endpoints (99.6%)
  get a VLAN, across 82 VLANs.
- **A VLAN's category classifies its unknown devices** — when a VLAN has a category,
  endpoints on it that OUI/hostname classification left as Unknown take that category.
  Devices that were already identified keep their own category. Those rows show the
  category badge with a dashed border and a "Classified by VLAN name" tooltip.
- **VLAN column and filter on the device table** — each row shows `220 · Cameras`;
  clicking it (or "Show devices" on the VLANs tab) filters the table to that VLAN, and
  the search box also matches VLAN names. Viewers see the names read-only; only admins
  can edit them (`PUT /api/inventory/vlans/:id`), and every change is written to the
  audit log.

### Fixed
- **Diagnostics report on IIS installs said the poller was missing** —
  `collect-diagnostics.ps1` checked only Windows services, but an IIS deployment runs the
  poller as the `NetMonitor Poller` Scheduled Task. The report now has a Scheduled Tasks
  section with its state, last run and last result.
- **CHANGELOG v1.3.0 deployment note** said `sc query TKCSPoller`. In PowerShell `sc` is
  an alias for `Set-Content`, so the command silently wrote a file named `query` instead
  of checking anything, and `TKCSPoller` was never the service name. It now reads
  `Get-Service TKCommsSentinelPoller`.

## [1.3.9] — 2026-09-17

### Fixed
- **Inventory showed "Error" and no rows at all** — the summary and table queries joined
  `hostname_cache` on `hc.ip_address`, but that table's column is `ip`, so every request
  failed with `no such column` and returned a 500. The page surfaced that only as a red
  "Error" label, which is why nothing loaded.
- **Inventory query timed out on a real dataset** — uplink detection ran a correlated
  `COUNT(DISTINCT mac_address)` subquery once per row, i.e. once per each of 970K
  `mac_entries` rows. Replaced with a single pre-aggregated `uplink_ports` CTE.
- **Most of the network was missing from Inventory, and searching a subnet found nothing**
  — the query required `phys_if_index IS NOT NULL`, which silently dropped every
  ARP-learned entry: 5,266 rows, including *all* of the wireless subnets. Those rows come
  from a router's ARP table rather than a switch MAC table, so they have no switch port
  and the uplink test cannot apply to them — they are edge devices by definition. Entering
  an AP subnet in the search box returned "No data" purely because of this.
- **Most rows showed no IP address** — a switch MAC table yields a MAC and a port but no
  IP, leaving about a third of rows blank. The same MAC generally also appears in a
  router's ARP table carrying its address, so the two are now cross-referenced by MAC
  (most recent observation wins, which is correct under DHCP). IP coverage went from 64%
  to 94% and hostname coverage from 24% to 42%. The addresses still missing have no PTR
  record at all, so neither DNS nor `ping -a` can name them.
- **Aruba access points were counted as computers** — HPE registers Aruba APs and
  ProLiant servers under the same `Hewlett Packard Enterprise` OUI name, so the vendor
  string alone cannot tell them apart and every AP fell through to the Computers rule.
  APs here are named `<Location>_<last 2 MAC bytes>` (`ec:1b:5f:c2:31:41` resolves to
  `TZ_Flr0_Cardio_Eco_31:41`), which servers and iLO interfaces never are; that split is
  exact across all 239 resolvable HPE devices. Where an AP has no PTR record the verdict
  is taken from its /24, since AP subnets resolve unanimously to APs while server subnets
  score zero. Access Points went from 0 to 571, with the ESXi, iLO and `SRV-*` subnets
  verified to stay out of the category.

### Added
- **Reverse-DNS backfill for endpoint names** — addresses the poller has not resolved yet
  are looked up and written into `hostname_cache`, so names fill in as the page is used.
  Each address is attempted once per process, since roughly half have no PTR record and
  retrying them on every request would be pure waste.
- **Inventory search now also matches switch port descriptions** (`if_alias`/`if_name`),
  alongside MAC, IP, hostname, vendor and switch name.

## [1.3.8] — 2026-09-17

### Added
- **Endpoint Inventory page** — classifies every active endpoint on the network by MAC OUI
  (manufacturer prefix) into Computers, Printers, Access Points, Cameras, Medical Devices,
  Network Infrastructure, VMs and Unknown. Ships a bundled 40,161-entry IEEE OUI database
  (`backend/data/oui.json`), summary cards per category, and a searchable, filterable,
  paginated table. Uplink ports are excluded so the list reflects real endpoints rather
  than traffic transiting a trunk. Hebrew and English UI.

## [1.3.7] — 2026-09-17

### Added
- **"Collect Diagnostics" tool** — new Start Menu shortcut (and standalone script,
  `installer/scripts/collect-diagnostics.ps1`) that gathers a single, safe-to-share
  report for remote troubleshooting: installed version, which build the `current`
  junction actually points at, both services' status, the last 200 lines of each
  service's stdout/stderr log, which frontend bundle files are on disk vs which one
  `index.html` references (catches stale-build/stale-cache mismatches at a glance),
  database schema shape and **row counts only** (never row data — no device inventory,
  SNMP community strings, or credentials leave the machine), `.env` key names only
  (never values), and basic OS/Node/disk info. Entirely read-only: never stops a
  service, never writes to the database, doesn't require Administrator.

### Fixed
- **`package\installer\scripts\` was never synced from the canonical `installer\scripts\`**
  — the folder the installer `.exe` actually bundles is a separate copy that nothing in
  `deploy-local.ps1` kept up to date, so an edit made only under `installer\scripts\`
  (the git-tracked source) could silently never reach a built installer. Same class of
  bug as the `backend\db\` exclusion fixed in v1.3.6. `deploy-local.ps1` now syncs
  `installer\scripts\` -> `package\installer\scripts\` on every deploy, before compiling.

## [1.3.6] — 2026-09-16

### Fixed
- **Deploy pipeline silently dropped every code change under `backend/db/`** — root cause
  of both "Audit page still in Hebrew" and "main search finds nothing" reported today.
  `deploy-local.ps1` excluded the entire `backend\db\` directory from the IIS/package
  robocopy (`/XD ... db ...`) to protect the live `netmonitor.db` file, but that also
  silently blocked `database.js` and `audit.js` code changes from ever reaching
  production — so the v1.3.4 audit-log migration (`msg_key`/`msg_params` columns) and the
  v1.3.5 `hostname_cache` table were never actually created on the live server. Every
  `logAudit()` call was failing silently (audit rows stopped being written at all since
  the v1.3.4 deploy), and every hostname lookup was throwing `no such table: hostname_cache`
  inside `/api/search` and `/api/devices/endpoint-search`, which the frontend's search box
  swallows silently — explaining the empty dropdown. Fixed to exclude only the actual data
  files (`netmonitor.db*`) instead of the whole directory, so `backend/db/*.js` and
  `schema.sql` deploy normally from now on.
- **Endpoint IP/hostname blank in "Connected endpoints"** — `/api/devices/:id/port-endpoints/:ifIndex`
  returned the raw bridge-table row, which carries a MAC but never an IP of its own (IP
  comes from a separate ARP-learned row for the same MAC, usually on a different, L3
  device). Now cross-references other `mac_entries` rows for the same MAC to fill in the
  IP before hostname lookup, matching the logic already used by endpoint search.
- **False "FAN failed" hardware alarms on HPE 5130 (JH326A)** — the OID used for
  `hh3cFanStatus` returns ~200 rows on this switch (indices up to 955), not the handful a
  physical fan table would have; it is almost certainly a per-interface status table
  misidentified as fan status, and ports that happened to read a status of `1` showed up
  as failed fans. Now discards the reading entirely when the table returns more rows than
  are physically plausible for a fan bank, instead of showing spurious hardware failures.
- Added a **VLAN column** (from the already-collected `pvid`) to the ports table and port
  detail panel on the device page — the data was being collected by the poller but never
  shown.

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
4. Verify poller is running: `Get-Service TKCommsSentinelPoller` — if Stopped, run `Start-Service TKCommsSentinelPoller`
   (on an IIS deployment the poller is the Scheduled Task instead: `Get-ScheduledTask "NetMonitor Poller"`)
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
