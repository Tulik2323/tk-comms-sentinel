// routes/ports.js — פורטים של מכשיר
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getDb }           = require('../db/database');
const { requireAuth }     = require('../middleware/auth');
const { getPortStatuses } = require('../services/snmp');

// כל הפורטים של מכשיר, ממוינים לפי if_index
router.get('/', requireAuth, (req, res) => {
  const db      = getDb();
  const device  = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });

  const ports = db.prepare(`
    SELECT * FROM ports
    WHERE device_id = ?
    ORDER BY if_index ASC
  `).all(req.params.id);

  res.json(ports);
});

// GET /api/devices/:id/ports/changes — היסטוריית שינויי פורטים (14 יום)
router.get('/changes', requireAuth, (req, res) => {
  const db     = getDb();
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });

  const changes = db.prepare(`
    SELECT id, if_index, if_name, attribute, old_value, new_value, changed_at
    FROM port_changes
    WHERE device_id = ?
    ORDER BY changed_at DESC
    LIMIT 300
  `).all(req.params.id);

  res.json(changes);
});

// GET /api/devices/:id/ports/live-status — קריאת SNMP ישירה לסטטוס פורטים (Port Watchdog)
router.get('/live-status', requireAuth, async (req, res) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });
  if (device.status === 'unknown') return res.status(400).json({ error: 'מכשיר לא מוגדר' });

  try {
    const ports = await getPortStatuses(device);
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
