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
  login_2fa_failed:    p => `2FA code rejected: ${p.username}`,
  login_locked:        p => `Sign-in temporarily blocked after repeated failures: ${p.username}`,
  logout:              p => `Logout: ${p.username}`,
  twofa_setup_done:    p => `2FA set up and verified: ${p.username}`,
  twofa_reset:         p => `2FA reset for ${p.username}`,
  user_created:        p => `User created: ${p.username} (${p.role})`,
  user_updated:        p => `User updated: ${p.username} — ${p.changes}`,
  user_deleted:        p => `User deleted: ${p.username}`,
  device_added:        p => `Device added: ${p.device} (${p.ip})`,
  device_updated:      p => `Device updated: ${p.device} — ${p.fields}`,
  device_deleted:      p => `Device deleted: ${p.device} (${p.ip})`,
  threshold_saved:     p => `Alert threshold saved (${p.scope}): ${p.metric} ≥ ${p.pct}% for ${p.duration} min`,
  threshold_saved_nodur: p => `Alert threshold saved (${p.scope}): ${p.metric} ≥ ${p.pct}%, duration inherited`,
  threshold_disabled:  p => `Alert threshold disabled (${p.scope}): ${p.metric}`,
  threshold_deleted:   p => `Alert threshold deleted (${p.scope}): ${p.metric}`,
  map_image_uploaded:  p => `Map image uploaded (${p.mime}, ${p.size} bytes)`,
  map_image_deleted:   () => 'Map image deleted',
  license_activated:   p => `License activated${p.customer ? ` for ${p.customer}` : ''}${p.expiry ? `, valid until ${p.expiry}` : ''}`,
  report_schedule_created: p => `Report schedule created: ${p.name} (${p.report_type}, ${p.cron_expr})`,
  report_schedule_updated: p => `Report schedule updated: ${p.name}`,
  report_schedule_deleted: p => `Report schedule deleted: ${p.name}`,
  scan_started:        p => `Scan started: ${p.target} (${p.count} IPs)`,
  scan_found:          p => `Scan found new SNMP device: ${p.ip}`,
  scan_error:          p => `Scan error for ${p.ip}: ${p.error}`,
  scan_complete:       p => `Scan complete: ${p.target} — found ${p.found} SNMP devices, ${p.added} new`,
  vlan_name_updated:   p => `VLAN ${p.vlan} set to "${p.name}"${p.category ? ` (category: ${p.category})` : ''}`,
  vlan_name_cleared:   p => `VLAN ${p.vlan} name cleared`,
  inv_category_created: p => `Inventory category created: "${p.name}"`,
  inv_category_updated: p => `Inventory category "${p.old}" changed to "${p.name}"`,
  inv_category_deleted: p => `Inventory category deleted: "${p.name}" (${p.vlans} VLANs cleared)`,
  audit_purged:        p => `Audit log purged: ${p.deleted} entries older than ${p.days} days deleted`,
  alerts_resolved_selected: p => `Closed ${p.count} selected open alerts`,
  alerts_resolved_all:      p => `Closed all ${p.count} open alerts`,
  csv_import:          p => `CSV import: ${p.added} added, ${p.skipped} skipped, ${p.errors} errors`,
  diagnose:            p => `Diagnostics run against ${p.host}`,
  update_triggered:    p => `System update triggered to version ${p.version}`,
  update_refused:      p => `Update refused: ${p.reason}`,
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
// ::ffff:10.1.2.3 היא אותה כתובת כמו 10.1.2.3. Node מדווח על לקוח IPv4 בצורה הראשונה כשהשרת מאזין על IPv6,
// ובלי הנרמול אותו לקוח נראה בלוג ובמגבלת הניסיונות כשתי כתובות שונות.
function normalizeIp(ip) {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip || ''));
  return m ? m[1] : (ip || null);
}

function logAudit(level, source, key, params = {}, extra = {}) {
  try {
    const message = (EN_TEMPLATES[key] ? EN_TEMPLATES[key](params) : key);
    getDb().prepare(`
      INSERT INTO audit_log (level, source, message, msg_key, msg_params, device_id, ip, username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(level, source, message, key, JSON.stringify(params),
      extra.device_id || null,
      normalizeIp(extra.ip),
      extra.username  || null
    );
  } catch (_) {
    // אל תיפול אם DB לא מוכן עדיין
  }
}

module.exports = { logAudit, normalizeIp };
