// services/reports.js — יצירת דוחות לפי סוג
const { getDb } = require('../db/database');
const { toCSV } = require('./csv');   // כולל נטרול נוסחאות של Excel

// ---- דוח 1: זמינות מכשירים (Uptime %) ----
function generateUptime({ period_days = 7 } = {}) {
  const db = getDb();
  const periodSec = period_days * 86400;
  const fromTs    = Math.floor(Date.now() / 1000) - periodSec;

  // זמן DOWN לפי אירועי התראה
  const downTimes = db.prepare(`
    SELECT device_id,
           SUM(COALESCE(resolved_at, unixepoch()) - opened_at) AS down_sec
    FROM alert_events
    WHERE metric = 'status'
      AND opened_at >= ?
    GROUP BY device_id
  `).all(fromTs);

  const downMap = {};
  for (const r of downTimes) downMap[r.device_id] = r.down_sec;

  const devices = db.prepare(`SELECT id, name, ip, status, location FROM devices ORDER BY name`).all();

  const headers = ['שם מכשיר', 'כתובת IP', 'מיקום', 'זמינות %', 'זמן DOWN (דק)', 'סטטוס נוכחי'];
  const rows = devices.map(d => {
    const downSec  = downMap[d.id] || 0;
    const upPct    = Math.max(0, Math.min(100, ((periodSec - downSec) / periodSec) * 100));
    return [d.name || '', d.ip, d.location || '', upPct.toFixed(2), Math.round(downSec / 60), d.status];
  });

  return { title: `זמינות מכשירים — ${period_days} ימים אחרונים`, headers, rows };
}

// ---- דוח 2: תעבורה גבוהה — Top Ports ----
function generateTopPorts({ limit = 20 } = {}) {
  const db = getDb();
  const rows_raw = db.prepare(`
    SELECT
      d.name AS device_name, d.ip,
      p.if_name, p.if_alias, p.if_descr,
      p.in_bps, p.out_bps, p.if_speed, p.oper_status
    FROM ports p
    JOIN devices d ON d.id = p.device_id
    WHERE (p.in_bps + p.out_bps) > 0
    ORDER BY (p.in_bps + p.out_bps) DESC
    LIMIT ?
  `).all(limit);

  const fmt = (bps) => bps == null ? '0' : (bps / 1e6).toFixed(2);
  const headers = ['מכשיר', 'IP', 'פורט', 'תיאור', 'כניסה Mbps', 'יציאה Mbps', 'כולל Mbps', 'ניצול %', 'סטטוס'];
  const rows = rows_raw.map(r => {
    const totalMbps = (r.in_bps + r.out_bps) / 1e6;
    const utilPct   = r.if_speed > 0 ? ((r.in_bps + r.out_bps) / r.if_speed * 100).toFixed(1) : '';
    return [
      r.device_name || '', r.ip,
      r.if_alias || r.if_name || '', r.if_descr || '',
      fmt(r.in_bps), fmt(r.out_bps), totalMbps.toFixed(2),
      utilPct, r.oper_status,
    ];
  });

  return { title: `${limit} פורטים עם תעבורה גבוהה`, headers, rows };
}

// ---- דוח 3: היסטוריית התראות ----
function generateAlertHistory({ period_days = 7 } = {}) {
  const db = getDb();
  const fromTs = Math.floor(Date.now() / 1000) - period_days * 86400;

  const rows_raw = db.prepare(`
    SELECT
      ae.id, ae.metric, ae.value, ae.threshold,
      ae.message, ae.sent_at, ae.resolved_at,
      d.name AS device_name, d.ip
    FROM alert_events ae
    LEFT JOIN devices d ON d.id = ae.device_id
    WHERE ae.sent_at >= ?
    ORDER BY ae.sent_at DESC
  `).all(fromTs);

  const fmtTs = (ts) => ts ? new Date(ts * 1000).toLocaleString('he-IL') : '';
  const headers = ['#', 'מכשיר', 'IP', 'מטריקה', 'ערך', 'סף', 'זמן פתיחה', 'זמן סגירה', 'הודעה'];
  const rows = rows_raw.map(r => [
    r.id,
    r.device_name || '(נמחק)',
    r.ip || '',
    r.metric || '',
    r.value != null ? r.value.toFixed(1) : '',
    r.threshold != null ? r.threshold.toFixed(1) : '',
    fmtTs(r.sent_at),
    fmtTs(r.resolved_at),
    r.message || '',
  ]);

  return { title: `היסטוריית התראות — ${period_days} ימים אחרונים`, headers, rows };
}

// ---- דוח 4: שגיאות פורטים ----
function generatePortErrors({ min_errors = 0 } = {}) {
  const db = getDb();
  const rows_raw = db.prepare(`
    SELECT
      d.name AS device_name, d.ip,
      p.if_name, p.if_alias, p.if_descr,
      p.in_errors, p.out_errors, p.oper_status, p.last_updated
    FROM ports p
    JOIN devices d ON d.id = p.device_id
    WHERE (p.in_errors + p.out_errors) > ?
    ORDER BY (p.in_errors + p.out_errors) DESC
  `).all(min_errors);

  const fmtTs = (ts) => ts ? new Date(ts * 1000).toLocaleString('he-IL') : '';
  const headers = ['מכשיר', 'IP', 'פורט', 'תיאור', 'שגיאות כניסה', 'שגיאות יציאה', 'סה"כ', 'סטטוס', 'עדכון אחרון'];
  const rows = rows_raw.map(r => [
    r.device_name || '', r.ip,
    r.if_alias || r.if_name || '', r.if_descr || '',
    r.in_errors, r.out_errors, r.in_errors + r.out_errors,
    r.oper_status, fmtTs(r.last_updated),
  ]);

  return { title: 'שגיאות פורטים', headers, rows };
}

const GENERATORS = {
  uptime:      generateUptime,
  top_ports:   generateTopPorts,
  alert_history: generateAlertHistory,
  port_errors: generatePortErrors,
};

function generateReport(type, params = {}) {
  const gen = GENERATORS[type];
  if (!gen) throw new Error(`סוג דוח לא מוכר: ${type}`);
  return gen(params);
}

module.exports = { generateReport, toCSV, GENERATORS };
