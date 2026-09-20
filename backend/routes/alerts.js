// routes/alerts.js — לוג התראות והגדרות סף
const express = require('express');
const router  = express.Router();
const { getDb }                    = require('../db/database');
const { requireAuth, requireAdmin }= require('../middleware/auth');
const { DEVICE_METRICS, DEFAULT_DURATION_MIN, parsePct, parseDuration, saveThreshold } = require('../services/thresholds');
const { logAudit }                 = require('../db/audit');

// רשימת אירועי התראה (50 אחרונים). status=open: רק הפתוחים.
// total הוא לפי הסינון (לעימוד), ו-open_total הוא מספר כל האירועים הפתוחים.
router.get('/events', requireAuth, (req, res) => {
  const db     = getDb();
  const limit  = parseInt(req.query.limit  || '50');
  const offset = parseInt(req.query.offset || '0');
  const where  = req.query.status === 'open' ? 'WHERE e.resolved_at IS NULL' : '';

  // port_label מאפשר ל-UI לבנות מחדש את נוסח ההתראה בשפה הנבחרת,
  // במקום להציג את ה-message העברי הקפוא שנשמר ב-DB.
  const events = db.prepare(`
    SELECT e.*, d.name AS device_name, d.ip AS device_ip,
           COALESCE(p.if_alias, p.if_name, p.if_descr) AS port_label
    FROM alert_events e
    LEFT JOIN devices d ON d.id = e.device_id
    LEFT JOIN ports   p ON p.device_id = e.device_id AND p.if_index = e.port_if_index
    ${where}
    ORDER BY e.sent_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total     = db.prepare(`SELECT COUNT(*) AS n FROM alert_events e ${where}`).get().n;
  const openTotal = db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE resolved_at IS NULL').get().n;
  res.json({ events, total, open_total: openTotal });
});

// סגירה ידנית של אירועים פתוחים: ids = הנבחרים, או all=true לכל הפתוחים.
// האירועים לא נמחקים — הם מסומנים כסגורים.
const MAX_RESOLVE_IDS = 5000;
router.post('/events/resolve', requireAdmin, (req, res) => {
  const db = getDb();
  const { ids, all } = req.body || {};
  let closed;

  if (all === true) {
    closed = db.prepare('UPDATE alert_events SET resolved_at = unixepoch() WHERE resolved_at IS NULL').run().changes;
  } else if (Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_RESOLVE_IDS && ids.every(Number.isInteger)) {
    const close = db.prepare('UPDATE alert_events SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL');
    closed = db.transaction(() => ids.reduce((n, id) => n + close.run(id).changes, 0))();
  } else {
    return res.status(400).json({ error: `נדרש ids (מערך של מספרים שלמים, עד ${MAX_RESOLVE_IDS}) או all=true` });
  }

  if (closed > 0) {
    logAudit('info', 'admin', all === true ? 'alerts_resolved_all' : 'alerts_resolved_selected',
      { count: closed }, { username: req.user?.username, ip: req.ip });
  }
  res.json({ ok: true, closed });
});

// התראות שחוזרות: אותו מכשיר / פורט / מטריקה שהתריע לפחות ב-3 ימים שונים ב-7 הימים
// האחרונים. חזרה לאורך שבוע אומרת שזה לא ספייק חולף אלא מצב שדורש בדיקה, או סף שצריך
// להתאים. נספרים גם אירועים סגורים — סגירה אוטומטית לא אמורה להסתיר חזרתיות.
const RECURRING_WINDOW_DAYS = 7;
const RECURRING_MIN_DAYS    = 3;
router.get('/recurring', requireAuth, (req, res) => {
  const db = getDb();
  const items = db.prepare(`
    SELECT e.device_id, e.metric, e.port_if_index,
           COUNT(*) AS events,
           COUNT(DISTINCT date(e.sent_at, 'unixepoch', 'localtime')) AS days,
           MAX(e.sent_at) AS last_at,
           d.name AS device_name, d.ip AS device_ip,
           COALESCE(p.if_alias, p.if_name, p.if_descr) AS port_label
    FROM alert_events e
    JOIN devices d ON d.id = e.device_id
    LEFT JOIN ports p ON p.device_id = e.device_id AND p.if_index = e.port_if_index
    WHERE e.sent_at >= unixepoch() - ?
      AND e.metric IN ('bandwidth_in','bandwidth_out','cpu','mem','port_bandwidth_in','port_bandwidth_out')
    GROUP BY e.device_id, e.metric, e.port_if_index
    HAVING days >= ?
    ORDER BY days DESC, events DESC
    LIMIT 100
  `).all(RECURRING_WINDOW_DAYS * 86400, RECURRING_MIN_DAYS);
  res.json({ items, windowDays: RECURRING_WINDOW_DAYS, minDays: RECURRING_MIN_DAYS });
});

// הגדרות סף: גלובלי, למכשיר, ולפורט (כל סף פורט מסומן scope='port' ומכיל את ה-if_index)
router.get('/thresholds', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.id, t.device_id, t.metric, t.threshold_pct, t.duration_min, t.enabled,
           NULL AS port_if_index, NULL AS port_label, 'device' AS scope,
           d.name AS device_name, d.ip AS device_ip
    FROM alert_thresholds t
    LEFT JOIN devices d ON d.id = t.device_id
    WHERE t.port_if_index IS NULL
  `).all();

  const portRows = db.prepare(`
    SELECT t.id, t.device_id, t.metric, t.threshold_pct, t.duration_min, t.enabled,
           t.if_index AS port_if_index, COALESCE(p.if_alias, p.if_name, p.if_descr) AS port_label, 'port' AS scope,
           d.name AS device_name, d.ip AS device_ip
    FROM alert_port_thresholds t
    LEFT JOIN devices d ON d.id = t.device_id
    LEFT JOIN ports   p ON p.device_id = t.device_id AND p.if_index = t.if_index
  `).all();

  // גלובלי קודם, אחריו כל מכשיר עם סף הפורטים שלו
  const all = [...rows, ...portRows].sort((a, b) =>
    (a.device_id ?? -1) - (b.device_id ?? -1) ||
    (a.port_if_index ?? -1) - (b.port_if_index ?? -1) ||
    a.metric.localeCompare(b.metric));
  res.json(all);
});

// עדכון/יצירת סף להתראה (גלובלי, או למכשיר אם נשלח device_id)
router.put('/thresholds', requireAdmin, (req, res) => {
  const { device_id, metric, threshold_pct, enabled, duration_min } = req.body || {};
  const db = getDb();

  if (!DEVICE_METRICS.includes(metric)) {
    return res.status(400).json({ error: `metric לא נתמך (${DEVICE_METRICS.join(' / ')})` });
  }
  const pct = parsePct(threshold_pct);
  if (pct == null) return res.status(400).json({ error: 'threshold_pct חייב להיות בין 1 ל-100' });
  const dur = parseDuration(duration_min);
  if (!dur.ok) return res.status(400).json({ error: 'duration_min חייב להיות מספר שלם בין 0 ל-1440' });

  const device = device_id ? db.prepare('SELECT id, name, ip FROM devices WHERE id = ?').get(device_id) : null;
  if (device_id && !device) {
    return res.status(404).json({ error: 'מכשיר לא נמצא' });
  }

  saveThreshold(db, {
    deviceId: device_id || null,
    metric,
    pct,
    duration: dur.value,
    enabled:  enabled !== false,
  });

  // המשך האפקטיבי נקרא מהשורה שנשמרה: אם לא נשלח, נשאר הקיים או ברירת המחדל
  const saved = db.prepare('SELECT duration_min FROM alert_thresholds WHERE device_id IS ? AND port_if_index IS NULL AND metric = ?')
    .get(device_id || null, metric);
  const scope = device ? (device.name || device.ip) : '*';
  const who   = { username: req.user.username, ip: req.ip, device_id: device ? device.id : null };
  if (enabled === false) logAudit('info', 'admin', 'threshold_disabled', { scope, metric }, who);
  else                   logAudit('info', 'admin', 'threshold_saved', { scope, metric, pct, duration: saved ? saved.duration_min : DEFAULT_DURATION_MIN }, who);

  res.json({ ok: true });
});

// מחק סף
router.delete('/thresholds/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT t.device_id, t.metric, d.name, d.ip
    FROM alert_thresholds t LEFT JOIN devices d ON d.id = t.device_id
    WHERE t.id = ?
  `).get(req.params.id);
  const removed = db.prepare('DELETE FROM alert_thresholds WHERE id = ?').run(req.params.id).changes;
  if (removed > 0 && row) {
    logAudit('info', 'admin', 'threshold_deleted', {
      scope: row.device_id ? (row.name || row.ip) : '*', metric: row.metric,
    }, { username: req.user.username, ip: req.ip, device_id: row.device_id || null });
  }
  res.json({ ok: true });
});

module.exports = router;
