// routes/systemStatus.js — האם הניטור עצמו פועל, ומקום פנוי בדיסק
// משמש את הפס האדום בראש כל מסך: כשה-poller לא פועל, הנתונים במסך ישנים ולא נשלחות
// התראות, והמשתמש חייב לדעת את זה (22/10/2026: 11.5 שעות של נתונים ישנים שנראו תקינים).
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { monitorStatus, diskStatus } = require('../services/systemHealth');

// GET /api/system-status — כל משתמש מחובר
router.get('/', requireAuth, (req, res) => {
  const m = monitorStatus();
  const d = diskStatus();
  res.json({
    ok: true,
    monitor: { heartbeat: m.heartbeat, age_sec: m.age_sec, stale: m.stale },
    disk:    d ? { free_gb: d.free_gb, free_pct: d.free_pct, low: d.low } : null,
  });
});

module.exports = router;
