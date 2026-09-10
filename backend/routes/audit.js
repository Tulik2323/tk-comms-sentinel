// routes/audit.js — לוג אירועי מערכת
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// GET /api/audit?limit=100&level=warn&source=poller&device_id=5&from=1700000000
router.get('/', requireAuth, (req, res) => {
  const { limit = 200, level, source, device_id, from } = req.query;

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
  params.push(parseInt(limit));

  const rows = getDb().prepare(sql).all(...params);
  res.json(rows);
});

// DELETE /api/audit — ניקוי לוג (admin בלבד)
const { requireAdmin } = require('../middleware/auth');
router.delete('/', requireAdmin, (req, res) => {
  const { older_than_days = 30 } = req.query;
  const cutoff = Math.floor(Date.now() / 1000) - parseInt(older_than_days) * 86400;
  const result = getDb().prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
  res.json({ deleted: result.changes });
});

module.exports = router;
