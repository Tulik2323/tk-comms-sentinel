'use strict';
// lib/license.js — machine fingerprint + ED25519 license validation
// Public key is embedded; private key lives ONLY on Tzvika's machine.
const crypto        = require('crypto');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { execSync }  = require('child_process');

const TRIAL_DAYS = 7;

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2HMtxL2FyjLwJ6nXwKVf3BAqlBM8zDi8L1PdneDcXvY=
-----END PUBLIC KEY-----`;

// Shared data directory: TKCS_DATA_DIR env → data\ sibling → ProgramData fallback.
function getDataDir() {
  if (process.env.TKCS_DATA_DIR) return process.env.TKCS_DATA_DIR;
  const dataSibling = path.resolve(__dirname, '..', '..', 'data');
  try {
    if (fs.statSync(dataSibling).isDirectory()) return dataSibling;
  } catch {}
  return 'C:\\ProgramData\\tknetmonitor';
}

function getLicensePath()   { return path.join(getDataDir(), 'license.key'); }
function getTrialStartPath() { return path.join(getDataDir(), 'trial-start.dat'); }

// Returns the trial-start date, creating the file on first call (= first run after install).
function getOrCreateTrialStart() {
  const p = getTrialStartPath();
  try {
    const d = new Date(fs.readFileSync(p, 'utf8').trim());
    if (!isNaN(d)) return d;
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, today, 'utf8');
  } catch {}
  return new Date(today);
}

// Stable hardware fingerprint: Windows MachineGuid (set once at OS install)
// combined with hostname. Falls back to first non-loopback MAC if reg fails.
function getMachineFingerprint() {
  const hostname = os.hostname().toUpperCase();
  let machineId  = '';

  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/);
    if (m) machineId = m[1].trim().toUpperCase();
  } catch {}

  if (!machineId) {
    const nets = os.networkInterfaces();
    outer: for (const iface of Object.values(nets)) {
      for (const net of iface) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          machineId = net.mac.toUpperCase().replace(/:/g, '');
          break outer;
        }
      }
    }
  }

  const raw  = `${hostname}|${machineId}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return [hash.slice(0,5), hash.slice(5,10), hash.slice(10,15), hash.slice(15,20)].join('-');
}

// License key format: base64url(JSON payload) + '.' + base64url(ED25519 signature)
function verifyLicenseKey(licenseKey) {
  const parts = licenseKey.trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload     = JSON.parse(payloadJson);
    const sigBuffer   = Buffer.from(sigB64, 'base64url');
    const valid = crypto.verify(null, Buffer.from(payloadJson, 'utf8'), PUBLIC_KEY, sigBuffer);
    return valid ? payload : null;
  } catch {
    return null;
  }
}

// Returns license status object — used by the REST endpoint and middleware.
// status values: 'trial' | 'trial-expired' | 'invalid' | 'valid' | 'grace' | 'expired'
function getLicenseStatus() {
  const fingerprint = getMachineFingerprint();
  const licensePath = getLicensePath();

  let licenseKey;
  try {
    licenseKey = fs.readFileSync(licensePath, 'utf8').trim();
  } catch {
    // No license file — evaluate trial period.
    const trialStart = getOrCreateTrialStart();
    const elapsed    = Math.floor((Date.now() - trialStart.getTime()) / (24 * 3600 * 1000));
    if (elapsed < TRIAL_DAYS) {
      return { status: 'trial', fingerprint, trialDaysLeft: TRIAL_DAYS - elapsed };
    }
    return { status: 'trial-expired', fingerprint };
  }

  const payload = verifyLicenseKey(licenseKey);
  if (!payload) {
    return { status: 'invalid', fingerprint };
  }
  if (payload.fp !== fingerprint) {
    return { status: 'invalid', fingerprint, reason: 'fingerprint_mismatch' };
  }

  const now      = new Date();
  const expiry   = new Date(payload.exp + 'T23:59:59');
  const grace    = payload.grace ?? 30;
  const graceEnd = new Date(expiry.getTime() + grace * 24 * 3600 * 1000);

  if (now <= expiry) {
    const daysLeft = Math.ceil((expiry - now) / (24 * 3600 * 1000));
    return { status: 'valid', fingerprint, expiry: payload.exp, daysLeft, customer: payload.cust, graceDays: grace };
  }
  if (now <= graceEnd) {
    const graceDaysLeft = Math.ceil((graceEnd - now) / (24 * 3600 * 1000));
    return { status: 'grace', fingerprint, expiry: payload.exp, daysLeft: 0, graceDaysLeft, customer: payload.cust, graceDays: grace };
  }
  return { status: 'expired', fingerprint, expiry: payload.exp, customer: payload.cust, graceDays: grace };
}

// Validate + save a license key; returns { ok, error?, status? }
function activateLicense(licenseKey) {
  const fingerprint = getMachineFingerprint();
  const payload     = verifyLicenseKey(licenseKey);

  if (!payload) {
    return { ok: false, error: 'מפתח רישוי לא תקף — חתימה שגויה' };
  }
  if (payload.fp !== fingerprint) {
    return { ok: false, error: 'מפתח רישוי מיועד למחשב אחר (טביעת אצבע לא תואמת)' };
  }

  const licensePath = getLicensePath();
  try {
    const dir = path.dirname(licensePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(licensePath, licenseKey.trim(), 'utf8');
  } catch (e) {
    return { ok: false, error: `לא ניתן לשמור רישוי: ${e.message}` };
  }

  return { ok: true, status: getLicenseStatus() };
}

module.exports = { getMachineFingerprint, getLicenseStatus, activateLicense };
