// routes/metrics.js — metrics היסטוריות ונוכחיות של מכשיר
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getDb }           = require('../db/database');
const { requireAuth }     = require('../middleware/auth');
const { getMetricsHistory }= require('../services/history');

// metrics ל-X שעות אחרונות (ברירת מחדל 24)
router.get('/', requireAuth, (req, res) => {
  const db     = getDb();
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });

  const hours  = parseInt(req.query.hours || '24');
  const toTs   = Math.floor(Date.now() / 1000);
  const fromTs = toTs - hours * 3600;

  const data = getMetricsHistory(parseInt(req.params.id), fromTs, toTs);
  res.json(data);
});

// סיכום: מינימום/מקסימום/ממוצע ל-24 שעות
router.get('/summary', requireAuth, (req, res) => {
  const db = getDb();
  const fromTs = Math.floor(Date.now() / 1000) - 86400;

  const summary = db.prepare(`
    SELECT
      AVG(cpu_pct)       AS avg_cpu,
      MAX(cpu_pct)       AS max_cpu,
      AVG(total_in_bps)  AS avg_in_bps,
      MAX(total_in_bps)  AS max_in_bps,
      AVG(total_out_bps) AS avg_out_bps,
      MAX(total_out_bps) AS max_out_bps,
      COUNT(*)           AS samples
    FROM metrics
    WHERE device_id = ? AND ts >= ?
  `).get(req.params.id, fromTs);

  res.json(summary);
});

module.exports = router;
