// routes/portChanges.js — יומן שינויי פורטים גלובלי
const express     = require('express');
const router      = express.Router();
const { getDb }   = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { DEVICE_LABEL_SQL } = require('../lib/deviceLabel');

const ATTRS = ['oper_status', 'if_alias', 'admin_status', 'if_speed', 'pvid'];

// רשימת מכשירים שיש להם שינויים (לפאנל השמאלי)
router.get('/devices', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.id, ${DEVICE_LABEL_SQL()} AS name, d.ip, d.status,
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
  const deviceId  = /^\d+$/.test(req.query.device_id || '') ? Number(req.query.device_id) : null;
  const limit     = Math.min(parseInt(req.query.limit) || 300, 1000);
  const attr      = ATTRS.includes(req.query.attr) ? req.query.attr : null;

  let sql = `
    SELECT pc.id, pc.device_id, pc.if_index, pc.if_name, pc.attribute,
           pc.old_value, pc.new_value, pc.changed_at,
           ${DEVICE_LABEL_SQL()} AS device_name, d.ip AS device_ip
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
