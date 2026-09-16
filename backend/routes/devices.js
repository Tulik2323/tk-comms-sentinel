// routes/devices.js — CRUD מכשירים, scan range, import CSV
const express = require('express');
const router  = express.Router();
const { getDb }         = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { pingSnmp }      = require('../services/snmp');
const { forcePoll }     = require('../services/poller');
const { logAudit }      = require('../db/audit');

// ייצוא כל המכשירים כ-CSV (לפני /:id כדי לא להתנגש)
router.get('/export', requireAuth, (req, res) => {
  const db = getDb();
  const devices = db.prepare(`
    SELECT ip, name, community, snmp_version, location, status, sys_name, notes
    FROM devices ORDER BY ip
  `).all();

  const BOM = '﻿';
  const headers = 'ip,name,community,snmp_version,location,status,sys_name,notes';
  const rows = devices.map(d =>
    [d.ip, d.name, d.community, d.snmp_version, d.location, d.status, d.sys_name, d.notes]
      .map(v => (v == null ? '' : String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : String(v)))
      .join(',')
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="devices_export.csv"');
  res.send(BOM + headers + '\n' + rows.join('\n'));
});

// רשימת כל המכשירים עם metrics אחרונות
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const devices = db.prepare(`
    SELECT d.*,
      m.total_in_bps, m.total_out_bps, m.cpu_pct, m.mem_pct, m.ts AS last_poll_ts
    FROM devices d
    LEFT JOIN (
      SELECT device_id, total_in_bps, total_out_bps, cpu_pct, mem_pct, MAX(ts) AS ts
      FROM metrics GROUP BY device_id
    ) m ON d.id = m.device_id
    ORDER BY d.name, d.ip
  `).all();

  res.json(devices);
});

// ===== חיפוש תחנת קצה לפי IP או MAC =====
// מחזיר מערך: [{ mac_address, ip_address, device_id, device_name, device_ip, if_name, if_index, last_seen }]
router.get('/endpoint-search', requireAuth, (req, res) => {
  const db = getDb();
  const q  = (req.query.q || '').trim().toLowerCase();
  if (q.length < 3) return res.json([]);

  // is_uplink: מכשיר נלמד בבת-אחת על כל הסוויצ'ים שבדרך אליו (הליבה כוללת),
  // לא רק על הפורט הפיזי שאליו הוא מחובר. ההבחנה האמינה ביותר בין הפורט
  // האמיתי לבין uplink היא כמה MAC-ים *נלמדו על אותו פורט*: פורט קצה למחשב
  // בודד לומד MAC אחד או שניים, בעוד פורט uplink/trunk לליבה לומד אלפים.
  // שם-הפורט (Trk/Po/Bond) הוא רק סימן משני — הרבה uplinks לא נקראים כך.
  // ACCESS_MAX_MACS: עד כמה MAC-ים על פורט עדיין נחשב "קצה". סף שמרני —
  // גם access-port עם switch קטן/IP-phone מאחוריו לא יחצה אותו, ואילו כל
  // uplink אמיתי (אלפי MAC) בוודאי כן.
  const ACCESS_MAX_MACS = 8;
  const baseSql = `
    SELECT me.mac_address, me.ip_address, me.device_id, me.phys_if_index,
           me.last_seen, d.name AS device_name, d.ip AS device_ip,
           p.if_name, p.if_alias,
           CASE WHEN me.phys_if_index IS NULL THEN NULL ELSE (
             SELECT COUNT(DISTINCT m2.mac_address) FROM mac_entries m2
             WHERE m2.device_id = me.device_id AND m2.phys_if_index = me.phys_if_index
           ) END AS macs_on_port,
           CASE
             WHEN me.phys_if_index IS NULL THEN 0
             WHEN (SELECT COUNT(DISTINCT m2.mac_address) FROM mac_entries m2
                   WHERE m2.device_id = me.device_id AND m2.phys_if_index = me.phys_if_index) > ${ACCESS_MAX_MACS}
             THEN 1 ELSE 0
           END AS is_uplink
    FROM mac_entries me
    JOIN devices d ON d.id = me.device_id
    LEFT JOIN ports p ON p.device_id = me.device_id AND p.if_index = me.phys_if_index
  `;

  // התאמה מדויקת קודם: substring לבד הופך "10.221.43.1" למתאים גם ל-
  // "10.221.43.10", "10.221.43.12" וכו' — מציף תוצאות של מכשירים אחרים
  // לגמרי סביב הפורט הנכון היחיד שהמשתמש מחפש. נופלים ל-substring רק
  // כשאין שום התאמה מדויקת (למשל חיפוש חלקי מכוון של MAC).
  let rows = db.prepare(`${baseSql} WHERE LOWER(me.ip_address) = ? OR LOWER(me.mac_address) = ? LIMIT 60`)
    .all(q, q);
  if (rows.length === 0) {
    rows = db.prepare(`${baseSql} WHERE LOWER(me.ip_address) LIKE ? OR LOWER(me.mac_address) LIKE ? LIMIT 60`)
      .all(`%${q}%`, `%${q}%`);
  }

  // חיפוש לפי IP מוצא רק את רשומת ה-ARP (מה-GW) — רשומות ה-bridge table
  // (סוויץ' + פורט פיזי) לא נושאות IP כלל, רק MAC. בלי הפיבוט הזה, חיפוש
  // לפי IP אף פעם לא יחשוף באיזה סוויץ'/פורט המכשיר מחובר בפועל.
  const macs = [...new Set(rows.map(r => r.mac_address).filter(Boolean))];
  if (macs.length > 0) {
    const placeholders = macs.map(() => '?').join(',');
    const macRows = db.prepare(`${baseSql} WHERE me.mac_address IN (${placeholders}) LIMIT 60`).all(...macs);
    const seen = new Set(rows.map(r => `${r.device_id}:${r.mac_address}:${r.phys_if_index}:${r.ip_address}`));
    for (const r of macRows) {
      const key = `${r.device_id}:${r.mac_address}:${r.phys_if_index}:${r.ip_address}`;
      if (!seen.has(key)) { rows.push(r); seen.add(key); }
    }
  }

  // בניית מיפוי MAC→IP משורות ה-ARP (רק הן נושאות IP), כדי לצרף את ה-IP
  // לשורת פורט הקצה (רשומת bridge — בלי IP משלה).
  const ipByMac = {};
  for (const r of rows) {
    if (r.ip_address && r.mac_address && !ipByMac[r.mac_address]) ipByMac[r.mac_address] = r.ip_address;
  }

  // פורטי קצה אמיתיים: יש phys_if_index והם *לא* uplink (מעט MAC-ים).
  // ממוינים לפי מספר MAC עולה — הפורט עם MAC בודד ראשון.
  const accessRows = rows
    .filter(r => r.phys_if_index != null && !r.is_uplink)
    .map(r => ({ ...r, ip_address: r.ip_address || ipByMac[r.mac_address] || null }))
    .sort((a, b) => (a.macs_on_port ?? Infinity) - (b.macs_on_port ?? Infinity) || b.last_seen - a.last_seen);

  // המשתמש רוצה את המקום האמיתי היחיד — לא רשימת uplinks. אם נמצא פורט קצה,
  // מחזירים רק אותו/אותם. רק אם לא נמצא שום פורט קצה (הסוויץ' לא מנוטר),
  // נופלים חזרה לכל מה שיש (uplinks + ARP) כדי לא להשאיר את המשתמש בלי כלום.
  if (accessRows.length > 0) {
    return res.json(accessRows.slice(0, 10));
  }

  rows.sort((a, b) => {
    const au = a.phys_if_index == null ? 2 : a.is_uplink;   // ARP row אחרון
    const bu = b.phys_if_index == null ? 2 : b.is_uplink;
    if (au !== bu) return au - bu;
    const am = a.macs_on_port == null ? Infinity : a.macs_on_port;
    const bm = b.macs_on_port == null ? Infinity : b.macs_on_port;
    if (am !== bm) return am - bm;
    return b.last_seen - a.last_seen;
  });
  res.json(rows.slice(0, 20));
});

// מכשיר בודד
router.get('/:id', requireAuth, (req, res) => {
  const db     = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });
  res.json(device);
});

// ===== היסטוריית תעבורה פר-פורט =====
router.get('/:id/port-history/:ifIndex', requireAuth, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const hours   = Math.min(Number(req.query.hours) || 24, 48);
  const rows = db.prepare(`
    SELECT ts, in_bps, out_bps, in_errors, out_errors
    FROM port_samples
    WHERE device_id = ? AND if_index = ? AND ts >= unixepoch() - ?*3600
    ORDER BY ts ASC
  `).all(devId, ifIndex, hours);
  res.json(rows);
});

// ===== תחנות קצה מחוברות לפורט =====
// מחזיר MAC + IP שנלמדו מ-ARP/Bridge על פורט זה (לפי phys_if_index)
router.get('/:id/port-endpoints/:ifIndex', requireAuth, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const rows = db.prepare(`
    SELECT mac_address, ip_address, last_seen
    FROM mac_entries
    WHERE device_id = ? AND phys_if_index = ?
    ORDER BY last_seen DESC
    LIMIT 30
  `).all(devId, ifIndex);
  res.json(rows);
});

// ===== סף התראה לפורט ספציפי =====

// GET /api/devices/:id/port-threshold/:ifIndex — סף נוכחי לפורט (port-specific > device > global)
router.get('/:id/port-threshold/:ifIndex', requireAuth, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);

  // סף ספציפי לפורט
  const portRow = db.prepare(`
    SELECT metric, threshold_pct, enabled, 'port' AS source
    FROM alert_thresholds
    WHERE device_id = ? AND port_if_index = ? AND enabled = 1
  `).all(devId, ifIndex);

  // סף ברמת מכשיר (ללא port_if_index)
  const devRows = db.prepare(`
    SELECT metric, threshold_pct, enabled, 'device' AS source
    FROM alert_thresholds
    WHERE device_id = ? AND port_if_index IS NULL AND enabled = 1
  `).all(devId);

  // גלובלי
  const globalRows = db.prepare(`
    SELECT metric, threshold_pct, enabled, 'global' AS source
    FROM alert_thresholds
    WHERE device_id IS NULL AND port_if_index IS NULL AND enabled = 1
  `).all();

  // בנה map של metric -> { threshold_pct, source }
  const map = {};
  for (const r of [...globalRows, ...devRows, ...portRow]) {
    map[r.metric] = { threshold_pct: r.threshold_pct, source: r.source };
  }

  // האם יש override ספציפי לפורט זה?
  const portOverrides = {};
  for (const r of portRow) portOverrides[r.metric] = r.threshold_pct;

  res.json({ effective: map, portOverrides });
});

// PUT /api/devices/:id/port-threshold/:ifIndex — קבע סף ספציפי לפורט
router.put('/:id/port-threshold/:ifIndex', requireAdmin, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const { metric, threshold_pct } = req.body;

  if (!metric || threshold_pct == null) {
    return res.status(400).json({ error: 'metric ו-threshold_pct נדרשים' });
  }

  db.prepare(`
    INSERT INTO alert_thresholds (device_id, port_if_index, metric, threshold_pct, enabled)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(device_id, port_if_index, metric) DO UPDATE
      SET threshold_pct = excluded.threshold_pct, enabled = 1
  `).run(devId, ifIndex, metric, Number(threshold_pct));

  res.json({ ok: true });
});

// DELETE /api/devices/:id/port-threshold/:ifIndex/:metric — הסר override ספציפי
router.delete('/:id/port-threshold/:ifIndex/:metric', requireAdmin, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const { metric } = req.params;

  db.prepare(`
    DELETE FROM alert_thresholds
    WHERE device_id = ? AND port_if_index = ? AND metric = ?
  `).run(devId, ifIndex, metric);

  res.json({ ok: true });
});

// הוסף מכשיר ידני
router.post('/', requireAdmin, async (req, res) => {
  const db = getDb();
  const {
    name, ip, snmp_version = 'v2c', community = 'public',
    snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
    poll_interval_sec = 300, location, notes
  } = req.body;

  if (!ip) return res.status(400).json({ error: 'IP נדרש' });

  try {
    const result = db.prepare(`
      INSERT INTO devices (name, ip, snmp_version, community,
        snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
        poll_interval_sec, location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, ip, snmp_version, community,
           snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
           poll_interval_sec, location, notes);

    const deviceId = result.lastInsertRowid;

    // poll מיידי
    forcePoll(deviceId).catch(() => {});

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    res.status(201).json(device);
  } catch (err) {
    if ((err?.message || String(err)).includes('UNIQUE')) {
      return res.status(409).json({ error: `IP ${ip} כבר קיים במערכת` });
    }
    throw err;
  }
});

// עדכון מכשיר
router.put('/:id', requireAdmin, (req, res) => {
  const db     = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });

  const {
    name, ip, snmp_version, community,
    snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
    poll_interval_sec, location, notes,
    map_x, map_y
  } = req.body;

  db.prepare(`
    UPDATE devices SET
      name = COALESCE(?, name),
      ip   = COALESCE(?, ip),
      snmp_version = COALESCE(?, snmp_version),
      community = COALESCE(?, community),
      snmp_v3_user = COALESCE(?, snmp_v3_user),
      snmp_v3_auth = COALESCE(?, snmp_v3_auth),
      snmp_v3_priv = COALESCE(?, snmp_v3_priv),
      poll_interval_sec = COALESCE(?, poll_interval_sec),
      location = COALESCE(?, location),
      notes = COALESCE(?, notes),
      map_x = COALESCE(?, map_x),
      map_y = COALESCE(?, map_y)
    WHERE id = ?
  `).run(name, ip, snmp_version, community,
         snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
         poll_interval_sec, location, notes,
         map_x, map_y,
         req.params.id);

  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id));
});

// מחק מכשיר
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'מכשיר לא נמצא' });
  res.json({ ok: true });
});

// force-poll מכשיר
router.post('/:id/poll', requireAdmin, async (req, res) => {
  try {
    const result = await forcePoll(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// סריקת טווח IPs — מוצא מכשירי SNMP
router.post('/scan', requireAdmin, async (req, res) => {
  const { start_ip, end_ip, cidr, community = 'public', snmp_version = 'v2c' } = req.body;

  let ips = [];
  if (cidr) {
    ips = expandCIDR(cidr);
  } else if (start_ip && end_ip) {
    ips = expandRange(start_ip, end_ip);
  } else {
    return res.status(400).json({ error: 'נדרש cidr או start_ip + end_ip' });
  }

  if (ips.length > 1024) {
    return res.status(400).json({ error: 'טווח גדול מדי (מקסימום 1024 IPs בסריקה)' });
  }

  const scanTarget = cidr || `${start_ip}–${end_ip}`;
  logAudit('info', 'admin', 'scan_started', { target: scanTarget, count: ips.length, community }, { username: req.user?.username });

  const db = getDb();
  const BATCH = 20;
  const found = [];
  const newDevices = [];

  for (let i = 0; i < ips.length; i += BATCH) {
    const batch = ips.slice(i, i + BATCH);
    await Promise.all(batch.map(async (ip) => {
      try {
        const responds = await pingSnmp(ip, community, snmp_version);
        if (responds) {
          found.push(ip);
          const result = db.prepare(`
            INSERT OR IGNORE INTO devices (ip, community, snmp_version)
            VALUES (?, ?, ?)
          `).run(ip, community, snmp_version);

          if (result.changes > 0) {
            newDevices.push(ip);
            logAudit('info', 'admin', 'scan_found', { ip }, { username: req.user?.username });
            forcePoll(result.lastInsertRowid).catch(() => {});
          }
        }
      } catch (e) {
        logAudit('warn', 'admin', 'scan_error', { ip, error: e.message }, { username: req.user?.username });
      }
    }));
  }

  logAudit('info', 'admin', 'scan_complete', { target: scanTarget, found: found.length, added: newDevices.length }, { username: req.user?.username });
  res.json({ message: `סריקה הושלמה`, total: ips.length, found: found.length, added: newDevices.length, devices: found });
});

// ייבוא CSV — פורמט: ip,name,community,snmp_version,location
router.post('/import-csv', requireAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv field נדרש' });

  const db    = getDb();
  const lines = csv.split('\n').filter(l => l.trim());
  const added = [], skipped = [], errors = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.toLowerCase().startsWith('ip')) continue;

    const [ip, name, community = 'public', snmp_version = 'v2c', location = ''] = line.split(',').map(s => s.trim());
    if (!ip) continue;

    try {
      const result = db.prepare(`
        INSERT OR IGNORE INTO devices (ip, name, community, snmp_version, location)
        VALUES (?, ?, ?, ?, ?)
      `).run(ip, name || null, community, snmp_version || 'v2c', location);

      if (result.changes > 0) {
        added.push(ip);
        forcePoll(result.lastInsertRowid).catch(() => {});
      } else {
        skipped.push(ip);
      }
    } catch (err) {
      errors.push({ ip, error: err.message });
    }
  }

  logAudit('info', 'admin', 'csv_import', { added: added.length, skipped: skipped.length, errors: errors.length }, { username: req.user?.username });
  res.json({ added, skipped, errors });
});

// --------- עזרים: חישוב טווח IPs ---------

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24), (long >>> 16 & 255), (long >>> 8 & 255), (long & 255)].join('.');
}

function expandRange(startIp, endIp) {
  const start = ipToLong(startIp);
  const end   = ipToLong(endIp);
  const ips   = [];
  for (let i = start; i <= end; i++) ips.push(longToIp(i));
  return ips;
}

function expandCIDR(cidr) {
  const [baseIp, prefixLen] = cidr.split('/');
  const prefix = parseInt(prefixLen);
  const base   = ipToLong(baseIp) & (~0 << (32 - prefix)) >>> 0;
  const count  = Math.pow(2, 32 - prefix);
  const ips    = [];
  for (let i = 1; i < count - 1; i++) ips.push(longToIp(base + i)); // skip network & broadcast
  return ips;
}

module.exports = router;
