// routes/devices.js — CRUD מכשירים, scan range, import CSV
const express = require('express');
const router  = express.Router();
const { getDb }         = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { pingSnmp }      = require('../services/snmp');
const { forcePoll }     = require('../services/poller');
const { logAudit }      = require('../db/audit');
const { attachHostnames } = require('../services/hostnames');
const { PORT_METRICS, DEFAULT_DURATION_MIN, parsePct, parseDuration, savePortThreshold } = require('../services/thresholds');
const { toCSV }         = require('../services/csv');
const { isIPv4, cleanText, intInRange, expandRange, expandCIDR } = require('../services/validate');

const SNMP_VERSIONS = ['v2c', 'v3'];
const MAX_SCAN_IPS  = 1024;

// מחרוזות ה-SNMP (community ופרטי v3) לעולם לא חוזרות ב-API: מי שרואה אותן יכול לשאול את הציוד
// ולעיתים גם לשנות אותו. במקומן חוזרים דגלים שמראים שהערך קיים; שם משתמש ה-v3 חוזר רק לאדמין.
function publicDevice(d, isAdmin) {
  if (!d) return d;
  const out = {
    ...d,
    has_community: Boolean(d.community),
    has_v3_auth:   Boolean(d.snmp_v3_auth),
    has_v3_priv:   Boolean(d.snmp_v3_priv),
  };
  delete out.community;
  delete out.snmp_v3_auth;
  delete out.snmp_v3_priv;
  if (!isAdmin) delete out.snmp_v3_user;
  return out;
}

// ייצוא כל המכשירים כ-CSV (לפני /:id כדי לא להתנגש). בלי community: הקובץ יוצא מהמערכת,
// ופרטי הגישה לציוד לא אמורים לנדוד איתו. פורמט הייבוא (עם community) לא השתנה.
router.get('/export', requireAuth, (req, res) => {
  const db = getDb();
  const devices = db.prepare(`
    SELECT ip, name, snmp_version, location, status, sys_name, notes
    FROM devices ORDER BY ip
  `).all();

  const BOM = '﻿';
  const csv = toCSV(
    ['ip', 'name', 'snmp_version', 'location', 'status', 'sys_name', 'notes'],
    devices.map(d => [d.ip, d.name, d.snmp_version, d.location, d.status, d.sys_name, d.notes])
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="devices_export.csv"');
  res.send(BOM + csv);
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

  res.json(devices.map(d => publicDevice(d, req.user.role === 'admin')));
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
    return res.json(attachHostnames(accessRows.slice(0, 10)));
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
  res.json(attachHostnames(rows.slice(0, 20)));
});

// מכשיר בודד
router.get('/:id', requireAuth, (req, res) => {
  const db     = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'מכשיר לא נמצא' });
  res.json(publicDevice(device, req.user.role === 'admin'));
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

  // רשומות bridge-table (פורט קצה) נושאות רק MAC, בלי IP משלהן — ה-IP
  // מגיע מרשומת ARP נפרדת (בדרך כלל מה-gateway/L3), שמזוהה לפי אותו MAC
  // בלי קשר למכשיר/פורט. בלעדי הפיבוט הזה רוב תחנות הקצה מוצגות בלי IP
  // וממילא גם בלי hostname (שתלוי ב-IP).
  const macsWithoutIp = [...new Set(rows.filter(r => !r.ip_address).map(r => r.mac_address))];
  let ipByMac = {};
  if (macsWithoutIp.length > 0) {
    const placeholders = macsWithoutIp.map(() => '?').join(',');
    const arpRows = db.prepare(`
      SELECT mac_address, ip_address FROM mac_entries
      WHERE mac_address IN (${placeholders}) AND ip_address IS NOT NULL
    `).all(...macsWithoutIp);
    ipByMac = Object.fromEntries(arpRows.map(r => [r.mac_address, r.ip_address]));
  }
  const enriched = rows.map(r => ({ ...r, ip_address: r.ip_address || ipByMac[r.mac_address] || null }));

  res.json(attachHostnames(enriched));
});

// ===== סף התראה לפורט ספציפי =====

// GET /api/devices/:id/port-threshold/:ifIndex — סף נוכחי לפורט (port-specific > device > global)
router.get('/:id/port-threshold/:ifIndex', requireAuth, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);

  // סף ספציפי לפורט
  const portRow = db.prepare(`
    SELECT metric, threshold_pct, duration_min, enabled, 'port' AS source
    FROM alert_port_thresholds
    WHERE device_id = ? AND if_index = ? AND enabled = 1
  `).all(devId, ifIndex);

  // סף ברמת מכשיר (ללא port_if_index)
  const devRows = db.prepare(`
    SELECT metric, threshold_pct, duration_min, enabled, 'device' AS source
    FROM alert_thresholds
    WHERE device_id = ? AND port_if_index IS NULL AND enabled = 1
  `).all(devId);

  // גלובלי
  const globalRows = db.prepare(`
    SELECT metric, threshold_pct, duration_min, enabled, 'global' AS source
    FROM alert_thresholds
    WHERE device_id IS NULL AND port_if_index IS NULL AND enabled = 1
  `).all();

  // בנה map של metric -> { threshold_pct, duration_min, source }.
  // סף פורט בלי משך משלו יורש את המשך של הסף שהוא דורס — כמו במנוע ההתראות.
  const map = {};
  for (const r of [...globalRows, ...devRows, ...portRow]) {
    const inherited = r.source === 'port' && map[r.metric] ? map[r.metric].duration_min : DEFAULT_DURATION_MIN;
    map[r.metric] = {
      threshold_pct: r.threshold_pct,
      duration_min:  r.duration_min ?? inherited,
      source:        r.source,
    };
  }

  // האם יש override ספציפי לפורט זה? (אחוז, ובנפרד המשך — null = ירושה)
  const portOverrides = {};
  const portOverrideDurations = {};
  for (const r of portRow) {
    portOverrides[r.metric] = r.threshold_pct;
    portOverrideDurations[r.metric] = r.duration_min;
  }

  res.json({ effective: map, portOverrides, portOverrideDurations });
});

// PUT /api/devices/:id/port-threshold/:ifIndex — קבע סף ספציפי לפורט
router.put('/:id/port-threshold/:ifIndex', requireAdmin, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const { metric, threshold_pct, duration_min } = req.body;

  if (!PORT_METRICS.includes(metric)) {
    return res.status(400).json({ error: `metric לא נתמך (${PORT_METRICS.join(' / ')})` });
  }
  const pct = parsePct(threshold_pct);
  if (pct == null) return res.status(400).json({ error: 'threshold_pct חייב להיות בין 1 ל-100' });
  const dur = parseDuration(duration_min);
  if (!dur.ok) return res.status(400).json({ error: 'duration_min חייב להיות מספר שלם בין 0 ל-1440' });

  if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(devId)) {
    return res.status(404).json({ error: 'מכשיר לא נמצא' });
  }

  // משך ריק = ירושה מסף המכשיר/הגלובלי
  savePortThreshold(db, { deviceId: devId, ifIndex, metric, pct, duration: dur.value ?? null });

  res.json({ ok: true });
});

// DELETE /api/devices/:id/port-threshold/:ifIndex/:metric — הסר override ספציפי
router.delete('/:id/port-threshold/:ifIndex/:metric', requireAdmin, (req, res) => {
  const db      = getDb();
  const devId   = Number(req.params.id);
  const ifIndex = Number(req.params.ifIndex);
  const { metric } = req.params;

  db.prepare(`
    DELETE FROM alert_port_thresholds
    WHERE device_id = ? AND if_index = ? AND metric = ?
  `).run(devId, ifIndex, metric);

  res.json({ ok: true });
});

// הוסף מכשיר ידני
// בדיקת שדות מכשיר מגוף בקשה (הוספה ועדכון). מחזיר { error } או { values }.
// שדה שלא נשלח נשאר undefined (בעדכון: הערך הקיים נשמר). מחרוזות סודיות ריקות נחשבות "לא שונה",
// כדי שטופס עריכה שלא הוקלד בו community חדש לא ימחק את הקיים.
function parseDeviceBody(body, { creating }) {
  const b = body || {};
  const v = {};

  v.ip = cleanText(b.ip, 45);
  if (creating ? !isIPv4(v.ip) : (v.ip !== undefined && !isIPv4(v.ip))) return { error: 'כתובת IP לא תקינה (IPv4)' };

  v.snmp_version = b.snmp_version === undefined && creating ? 'v2c' : b.snmp_version;
  if (v.snmp_version !== undefined && !SNMP_VERSIONS.includes(v.snmp_version)) {
    return { error: `גרסת SNMP לא תקינה (${SNMP_VERSIONS.join(' / ')})` };
  }

  v.poll_interval_sec = intInRange(b.poll_interval_sec, 30, 86400);
  if (v.poll_interval_sec === null) return { error: 'מרווח poll חייב להיות מספר שלם בין 30 ל-86400 שניות' };
  if (v.poll_interval_sec === undefined && creating) v.poll_interval_sec = 300;

  for (const [key, max] of [['name', 100], ['location', 200], ['notes', 1000], ['snmp_v3_user', 64]]) {
    v[key] = cleanText(b[key], max);
    if (v[key] === null) return { error: `${key} ארוך מדי או לא תקין` };
  }
  for (const [key, max] of [['community', 128], ['snmp_v3_auth', 128], ['snmp_v3_priv', 128]]) {
    v[key] = cleanText(b[key], max);
    if (v[key] === null) return { error: `${key} ארוך מדי או לא תקין` };
    if (v[key] === '') v[key] = undefined;
  }
  if (creating && v.community === undefined) v.community = 'public';

  // מיקום על המפה: מספרים בלבד
  for (const key of ['map_x', 'map_y']) {
    if (b[key] === undefined || b[key] === null) { v[key] = undefined; continue; }
    const n = Number(b[key]);
    if (!Number.isFinite(n)) return { error: `${key} חייב להיות מספר` };
    v[key] = n;
  }
  return { values: v };
}

router.post('/', requireAdmin, async (req, res) => {
  const db = getDb();
  const parsed = parseDeviceBody(req.body, { creating: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const {
    name, ip, snmp_version, community,
    snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
    poll_interval_sec, location, notes
  } = parsed.values;

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
    res.status(201).json(publicDevice(device, true));
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

  const parsed = parseDeviceBody(req.body, { creating: false });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const {
    name, ip, snmp_version, community,
    snmp_v3_user, snmp_v3_auth, snmp_v3_priv,
    poll_interval_sec, location, notes,
    map_x, map_y
  } = parsed.values;

  try {
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
  } catch (err) {
    if ((err?.message || String(err)).includes('UNIQUE')) {
      return res.status(409).json({ error: `IP ${ip} כבר קיים במערכת` });
    }
    throw err;
  }

  res.json(publicDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id), true));
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
  const { start_ip, end_ip, cidr } = req.body || {};
  const community    = cleanText(req.body && req.body.community, 128) || 'public';
  const snmp_version = (req.body && req.body.snmp_version) || 'v2c';
  if (!SNMP_VERSIONS.includes(snmp_version)) {
    return res.status(400).json({ error: `גרסת SNMP לא תקינה (${SNMP_VERSIONS.join(' / ')})` });
  }

  // הגודל נבדק לפני שנוצר מערך הכתובות: טווח /8 היה בונה 16 מיליון כתובות ומפיל את התהליך
  let ips = [];
  try {
    if (cidr) {
      ips = expandCIDR(cidr, MAX_SCAN_IPS);
    } else if (start_ip && end_ip) {
      ips = expandRange(start_ip, end_ip, MAX_SCAN_IPS);
    } else {
      return res.status(400).json({ error: 'נדרש cidr או start_ip + end_ip' });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // מחרוזת ה-community לא נרשמת ב-Audit: הלוג נקרא גם על ידי מי שלא אמור לדעת אותה
  const scanTarget = cidr || `${start_ip}–${end_ip}`;
  logAudit('info', 'admin', 'scan_started', { target: scanTarget, count: ips.length }, { username: req.user?.username });

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
const MAX_CSV_LINES = 5000;

router.post('/import-csv', requireAdmin, (req, res) => {
  const csv = req.body && req.body.csv;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv field נדרש' });

  const db    = getDb();
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length > MAX_CSV_LINES) {
    return res.status(400).json({ error: `יותר מדי שורות (מקסימום ${MAX_CSV_LINES})` });
  }
  const added = [], skipped = [], errors = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.toLowerCase().startsWith('ip')) continue;

    const [ip, name, community = 'public', snmp_version = 'v2c', location = ''] = line.split(',').map(s => s.trim());
    if (!ip) continue;

    // שורה לא תקינה נרשמת בדוח השגיאות ולא נכנסת ל-DB
    if (!isIPv4(ip))                                     { errors.push({ ip, error: 'כתובת IP לא תקינה' }); continue; }
    if (!SNMP_VERSIONS.includes(snmp_version || 'v2c'))  { errors.push({ ip, error: 'גרסת SNMP לא תקינה' }); continue; }
    if ((name || '').length > 100 || community.length > 128 || location.length > 200) {
      errors.push({ ip, error: 'שדה ארוך מדי' });
      continue;
    }

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

module.exports = router;
