// routes/dashboard.js — נתונים מצטברים ל-Dashboard
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// GET /api/dashboard/top-ports?limit=10
// 10 הפורטים הכי עמוסים ברגע זה (לפי in_bps + out_bps)
router.get('/top-ports', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10'), 50);
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      p.id, p.if_index, p.if_name, p.if_descr, p.if_alias,
      p.in_bps, p.out_bps, p.in_errors, p.out_errors,
      p.oper_status, p.if_speed,
      d.id   AS device_id,
      d.name AS device_name,
      d.ip   AS device_ip
    FROM ports p
    JOIN devices d ON d.id = p.device_id
    WHERE d.status = 'up'
      AND (p.in_bps + p.out_bps) > 0
    ORDER BY (p.in_bps + p.out_bps) DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// GET /api/dashboard/top-cpu?limit=5
// 5 המכשירים עם ה-CPU הגבוה ביותר (שורה אחרונה ב-metrics)
router.get('/top-cpu', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5'), 20);
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      d.id, d.name, d.ip, d.status, d.location,
      m.cpu_pct, m.mem_pct, m.ts
    FROM devices d
    JOIN (
      SELECT device_id, cpu_pct, mem_pct, ts,
             ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY ts DESC) AS rn
      FROM metrics
      WHERE cpu_pct IS NOT NULL
    ) m ON m.device_id = d.id AND m.rn = 1
    WHERE d.status = 'up'
    ORDER BY m.cpu_pct DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// GET /api/dashboard/duplicate-ips
// מזהה conflicts: מכשיר שה-sysName שלו שונה מהשם המוגדר (לא רק prefix/suffix —
// זה תקין, למשל "Pedi-Cam" מול "Pedi-Cam-01").
// הוסר: lldpConflicts — כל מכשיר מנוטר שמופיע כשכן LLDP של מכשיר אחר סומן
// כ"התנגשות" בטעות, וזו התנהגות LLDP רגילה לגמרי (false positive).
router.get('/duplicate-ips', requireAuth, (req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT ip, name, sys_name, status
    FROM devices
    WHERE status = 'up'
      AND name IS NOT NULL AND name != ''
      AND sys_name IS NOT NULL AND sys_name != ''
      AND LOWER(TRIM(name)) != LOWER(TRIM(sys_name))
    ORDER BY ip
  `).all();

  const nameConflicts = rows.filter(r => {
    const n  = r.name.toLowerCase().trim();
    const sn = r.sys_name.toLowerCase().trim();
    return !sn.includes(n) && !n.includes(sn);
  });

  res.json({ nameConflicts, lldpConflicts: [] });
});

// GET /api/dashboard/problem-ports?limit=10
// פורטים עם הכי הרבה התראות ב-24h האחרונות + שגיאות נוכחיות
router.get('/problem-ports', requireAuth, (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit || '10'), 50);
  const db      = getDb();
  const since24 = Math.floor(Date.now() / 1000) - 86400;

  const alertCounts = db.prepare(`
    SELECT device_id, port_if_index, COUNT(*) AS cnt
    FROM alert_events
    WHERE sent_at >= ? AND port_if_index IS NOT NULL
    GROUP BY device_id, port_if_index
  `).all(since24);
  const acMap = new Map();
  for (const r of alertCounts) acMap.set(`${r.device_id}:${r.port_if_index}`, r.cnt);

  const ports = db.prepare(`
    SELECT p.id, p.if_index, p.if_name, p.if_descr, p.if_alias,
           p.in_errors, p.out_errors, p.in_bps, p.out_bps, p.oper_status, p.if_speed,
           d.id AS device_id, d.name AS device_name, d.ip AS device_ip
    FROM ports p JOIN devices d ON d.id = p.device_id
    WHERE d.status = 'up'
  `).all();

  const scored = ports
    .map(p => {
      const alert_count = acMap.get(`${p.device_id}:${p.if_index}`) || 0;
      const total_errors = (p.in_errors || 0) + (p.out_errors || 0);
      return {
        ...p,
        alert_count,
        total_errors,
        score: alert_count * 100 + Math.min(total_errors, 999),
      };
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  res.json(scored);
});

module.exports = router;
