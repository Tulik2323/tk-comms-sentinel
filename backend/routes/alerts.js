// routes/alerts.js — לוג התראות והגדרות סף
const express = require('express');
const router  = express.Router();
const { getDb }                    = require('../db/database');
const { requireAuth, requireAdmin }= require('../middleware/auth');
const { DEVICE_METRICS, parsePct, parseDuration, saveThreshold } = require('../services/thresholds');

// רשימת אירועי התראה (50 אחרונים)
router.get('/events', requireAuth, (req, res) => {
  const db     = getDb();
  const limit  = parseInt(req.query.limit  || '50');
  const offset = parseInt(req.query.offset || '0');

  // port_label מאפשר ל-UI לבנות מחדש את נוסח ההתראה בשפה הנבחרת,
  // במקום להציג את ה-message העברי הקפוא שנשמר ב-DB.
  const events = db.prepare(`
    SELECT e.*, d.name AS device_name, d.ip AS device_ip,
           COALESCE(p.if_alias, p.if_name, p.if_descr) AS port_label
    FROM alert_events e
    LEFT JOIN devices d ON d.id = e.device_id
    LEFT JOIN ports   p ON p.device_id = e.device_id AND p.if_index = e.port_if_index
    ORDER BY e.sent_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS n FROM alert_events').get().n;
  res.json({ events, total });
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
  const { device_id, metric, threshold_pct, enabled, duration_min } = req.body;
  const db = getDb();

  if (!DEVICE_METRICS.includes(metric)) {
    return res.status(400).json({ error: `metric לא נתמך (${DEVICE_METRICS.join(' / ')})` });
  }
  const pct = parsePct(threshold_pct);
  if (pct == null) return res.status(400).json({ error: 'threshold_pct חייב להיות בין 1 ל-100' });
  const dur = parseDuration(duration_min);
  if (!dur.ok) return res.status(400).json({ error: 'duration_min חייב להיות מספר שלם בין 0 ל-1440' });

  if (device_id && !db.prepare('SELECT id FROM devices WHERE id = ?').get(device_id)) {
    return res.status(404).json({ error: 'מכשיר לא נמצא' });
  }

  saveThreshold(db, {
    deviceId: device_id || null,
    metric,
    pct,
    duration: dur.value,
    enabled:  enabled !== false,
  });

  res.json({ ok: true });
});

// מחק סף
router.delete('/thresholds/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM alert_thresholds WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
