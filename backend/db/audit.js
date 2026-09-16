// db/audit.js — כתיבה ללוג אירועי מערכת
const { getDb } = require('./database');

// תרגומי ברירת מחדל (אנגלית) לכל מפתח הודעה — נשמרים כ-message לתאימות
// לאחור (DB browser, לוגים ישנים) ולזיהוי מהיר בלי צורך בפענוח msg_params.
// ה-UI מציג תרגום מלא (עברית/אנגלית) מ-msg_key+msg_params כשהם קיימים.
const EN_TEMPLATES = {
  settings_updated:   p => `Settings updated: ${p.fields}`,
  smtp_test_ok:        p => `SMTP test succeeded: ${p.host}:${p.port}`,
  smtp_test_failed:    p => `SMTP test failed: ${p.error}`,
  test_email_sent:     p => `Test email sent to ${p.to}`,
  login_failed:        p => `Login failed: ${p.username} — ${p.error}`,
  login_2fa_required:  p => `Login: ${p.username} (${p.role}) — 2FA setup required`,
  login_2fa_success:   p => `Login with 2FA: ${p.username} (${p.role})`,
  twofa_setup_done:    p => `2FA set up and verified: ${p.username}`,
  scan_started:        p => `Scan started: ${p.target} (${p.count} IPs, community=${p.community})`,
  scan_found:          p => `Scan found new SNMP device: ${p.ip}`,
  scan_error:          p => `Scan error for ${p.ip}: ${p.error}`,
  scan_complete:       p => `Scan complete: ${p.target} — found ${p.found} SNMP devices, ${p.added} new`,
  csv_import:          p => `CSV import: ${p.added} added, ${p.skipped} skipped, ${p.errors} errors`,
  diagnose:            p => `Diagnostics run against ${p.host}`,
  update_triggered:    p => `System update triggered to version ${p.version}`,
  update_ps1_failed:   p => `Failed to run update.ps1: ${p.error}`,
  update_failed:       p => `Update failed: ${p.error}`,
  device_back_online:  p => `Device back online: ${p.device}`,
  device_unresponsive: p => `Device unresponsive: ${p.device} — ${p.why} [${p.error}]`,
  path_outage:         p => `Path outage: all ${p.count} devices unresponsive simultaneously. Likely a routing or firewall issue, not the devices themselves.`,
  path_recovered:      p => `Path recovered: ${p.responding} of ${p.total} devices responding.`,
};

/**
 * רשום אירוע בלוג
 * @param {string} level   - 'info' | 'warn' | 'error'
 * @param {string} source  - 'poller' | 'auth' | 'admin' | 'system'
 * @param {string} key     - מפתח תרגום (למשל 'login_failed')
 * @param {object} params  - פרמטרים להצבה בתרגום
 * @param {object} extra   - { device_id, ip, username } אופציונלי
 */
function logAudit(level, source, key, params = {}, extra = {}) {
  try {
    const message = (EN_TEMPLATES[key] ? EN_TEMPLATES[key](params) : key);
    getDb().prepare(`
      INSERT INTO audit_log (level, source, message, msg_key, msg_params, device_id, ip, username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(level, source, message, key, JSON.stringify(params),
      extra.device_id || null,
      extra.ip        || null,
      extra.username  || null
    );
  } catch (_) {
    // אל תיפול אם DB לא מוכן עדיין
  }
}

module.exports = { logAudit };
