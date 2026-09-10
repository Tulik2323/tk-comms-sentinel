// db/audit.js — כתיבה ללוג אירועי מערכת
const { getDb } = require('./database');

/**
 * רשום אירוע בlוג
 * @param {string} level   - 'info' | 'warn' | 'error'
 * @param {string} source  - 'poller' | 'auth' | 'admin' | 'system'
 * @param {string} message - הודעה
 * @param {object} extra   - { device_id, ip, username } אופציונלי
 */
function logAudit(level, source, message, extra = {}) {
  try {
    getDb().prepare(`
      INSERT INTO audit_log (level, source, message, device_id, ip, username)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(level, source, message,
      extra.device_id || null,
      extra.ip        || null,
      extra.username  || null
    );
  } catch (_) {
    // אל תיפול אם DB לא מוכן עדיין
  }
}

module.exports = { logAudit };
