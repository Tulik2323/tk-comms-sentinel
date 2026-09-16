// routes/alerts.js — לוג התראות והגדרות סף
const express = require('express');
const router  = express.Router();
const { getDb }                    = require('../db/database');
const { requireAuth, requireAdmin }= require('../middleware/auth');

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

// הגדרות סף לכל מכשירים (וגלובלי)
router.get('/thresholds', requireAuth, (req, res) => {
  const db = getDb();
  const thresholds = db.prepare(`
    SELECT t.*, d.name AS device_name, d.ip AS device_ip
    FROM alert_thresholds t
    LEFT JOIN devices d ON d.id = t.device_id
    ORDER BY t.device_id NULLS FIRST, t.metric
  `).all();
  res.json(thresholds);
});

// עדכון/יצירת סף להתראה
router.put('/thresholds', requireAdmin, (req, res) => {
  const { device_id, metric, threshold_pct, enabled } = req.body;
  const db = getDb();

  if (!metric) return res.status(400).json({ error: 'metric נדרש' });

  if (!device_id) {
    // ספים גלובליים: UNIQUE(device_id, metric) לא עוזר ל-NULL ב-SQLite.
    // partial index (idx_at_global_metric) מגן כעת, אבל UPSERT צריך להתאים.
    const existing = db.prepare(
      'SELECT id FROM alert_thresholds WHERE device_id IS NULL AND metric = ?'
    ).get(metric);
    if (existing) {
      db.prepare('UPDATE alert_thresholds SET threshold_pct=?, enabled=? WHERE id=?')
        .run(threshold_pct || 80, enabled !== false ? 1 : 0, existing.id);
    } else {
      db.prepare('INSERT INTO alert_thresholds (device_id, metric, threshold_pct, enabled) VALUES (NULL, ?, ?, ?)')
        .run(metric, threshold_pct || 80, enabled !== false ? 1 : 0);
    }
  } else {
    db.prepare(`
      INSERT INTO alert_thresholds (device_id, metric, threshold_pct, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, metric) DO UPDATE SET
        threshold_pct = excluded.threshold_pct,
        enabled       = excluded.enabled
    `).run(device_id, metric, threshold_pct || 80, enabled !== false ? 1 : 0);
  }

  res.json({ ok: true });
});

// מחק סף
router.delete('/thresholds/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM alert_thresholds WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
