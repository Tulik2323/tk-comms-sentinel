// routes/audit.js — לוג אירועי מערכת
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { logAudit }     = require('../db/audit');

// GET /api/audit?limit=100&level=warn&source=poller&device_id=5&from=1700000000
// admin בלבד: הלוג מכיל שמות משתמשים, כתובות ופרטי תצורה
router.get('/', requireAdmin, (req, res) => {
  const { level, source, device_id, from } = req.query;
  // limit לא תקין (NaN או שלילי, ש-SQLite מפרש כ"בלי הגבלה") מוחלף בברירת מחדל
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);

  let sql = `
    SELECT a.*, d.name AS device_name, d.ip AS device_ip
    FROM audit_log a
    LEFT JOIN devices d ON a.device_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (level)     { sql += ' AND a.level = ?';     params.push(level); }
  if (source)    { sql += ' AND a.source = ?';    params.push(source); }
  if (device_id) { sql += ' AND a.device_id = ?'; params.push(device_id); }
  if (from)      { sql += ' AND a.ts >= ?';        params.push(from); }

  sql += ' ORDER BY a.ts DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params);
  res.json(rows);
});

// DELETE /api/audit — ניקוי לוג ישן (admin בלבד). לא מוחקים לוג מתחת ל-7 ימים,
// והניקוי עצמו נרשם — אחרת אפשר למחוק את העקבות של עצמך.
const MIN_PURGE_DAYS = 7;
router.delete('/', requireAdmin, (req, res) => {
  const days = req.query.older_than_days === undefined ? 30 : Number(req.query.older_than_days);
  if (!Number.isInteger(days) || days < MIN_PURGE_DAYS) {
    return res.status(400).json({ error: `older_than_days חייב להיות מספר שלם, לפחות ${MIN_PURGE_DAYS}` });
  }
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const result = getDb().prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
  logAudit('warn', 'admin', 'audit_purged', { days, deleted: result.changes },
    { username: req.user?.username, ip: req.ip });
  res.json({ deleted: result.changes });
});

module.exports = router;
