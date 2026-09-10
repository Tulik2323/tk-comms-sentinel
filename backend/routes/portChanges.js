// routes/portChanges.js — יומן שינויי פורטים גלובלי
const express     = require('express');
const router      = express.Router();
const { getDb }   = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// רשימת מכשירים שיש להם שינויים (לפאנל השמאלי)
router.get('/devices', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.id, COALESCE(d.name, d.sys_name, d.ip) AS name, d.ip, d.status,
           COUNT(pc.id) AS change_count,
           MAX(pc.changed_at) AS last_change
    FROM port_changes pc
    JOIN devices d ON d.id = pc.device_id
    GROUP BY d.id
    ORDER BY last_change DESC
  `).all();
  res.json(rows);
});

// שינויים — לפי מכשיר ספציפי, או כל המכשירים
router.get('/', requireAuth, (req, res) => {
  const db        = getDb();
  const deviceId  = req.query.device_id || null;
  const limit     = Math.min(parseInt(req.query.limit) || 300, 1000);
  const attr      = req.query.attr || null;   // if_alias | admin_status | if_speed | pvid

  let sql = `
    SELECT pc.id, pc.device_id, pc.if_index, pc.if_name, pc.attribute,
           pc.old_value, pc.new_value, pc.changed_at,
           COALESCE(d.name, d.sys_name, d.ip) AS device_name, d.ip AS device_ip
    FROM port_changes pc
    JOIN devices d ON d.id = pc.device_id
    WHERE 1=1
  `;
  const params = [];

  if (deviceId) { sql += ' AND pc.device_id = ?'; params.push(deviceId); }
  if (attr)     { sql += ' AND pc.attribute = ?';  params.push(attr); }

  sql += ' ORDER BY pc.changed_at DESC LIMIT ?';
  params.push(limit);

  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
