# Changelog

All notable changes to TK Comms Sentinel are documented here.

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
