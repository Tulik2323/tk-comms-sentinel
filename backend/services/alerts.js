// services/alerts.js — בדיקת סף ושליחת מיילים
const nodemailer = require('nodemailer');
const { getDb, getSetting } = require('../db/database');
const { decrypt }           = require('./secrets');

// Map של מכשירים שנשלחה להם התראה (למניעת spam)
// deviceId_metric -> unixtime of last alert
const lastAlertSent = new Map();
const ALERT_COOLDOWN_SEC = 3600; // לא לשלוח יותר מפעם בשעה

// דורש N pollים עוקבים שהסף חצוי לפני שליחת התראה
// (כדי לסנן ספייקים חולפים)
const SUSTAINED_POLLS_REQUIRED = 2;
const breachCount = new Map(); // key -> מספר pollים עוקבים שחצו את הסף

// ערכי placeholder שהגיעו עם הפרויקט. אם הם נשארו — SMTP לא הוגדר באמת,
// וניסיון לשלוח אליהם רק תולה את התהליך על פתרון DNS שלעולם לא יצליח.
const PLACEHOLDER_HOSTS = ['mail.company.local', 'smtp.company.local', 'localhost.localdomain'];

// בנה transporter על פי הגדרות SMTP שב-DB
function createTransporter() {
  const host = (getSetting('smtp_host') || process.env.SMTP_HOST || '').trim();
  const port = parseInt(getSetting('smtp_port') || process.env.SMTP_PORT || '25');
  const user = getSetting('smtp_user') || process.env.SMTP_USER || '';
  const pass = decrypt(getSetting('smtp_pass') || '') || process.env.SMTP_PASS || '';

  if (!host) return null;
  if (PLACEHOLDER_HOSTS.includes(host.toLowerCase())) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized: false }, // סביבות ארגוניות עם self-signed certs
    // תקרות זמן מפורשות. ברירות המחדל של nodemailer הן דקתיים לחיבור
    // ועשר דקות ל-socket — נצח מבחינת לולאת ניטור.
    connectionTimeout: 5000,
    greetingTimeout:   5000,
    socketTimeout:     10000,
    dnsTimeout:        3000,
  });
}

// מפסק: אחרי כשל, לא מנסים שוב במשך דקות. בלי זה כל מכשיר שנופל
// מייצר ניסיון DNS/SMTP נוסף, וההשהיות מצטברות על כל הסבב.
let _smtpFailedUntil = 0;
const SMTP_BACKOFF_MS = 5 * 60 * 1000;

// בדיקה האם כרגע בתוך חלון שעות שקט (maintenance window).
// אם כן — לא שולחים מיילים, אבל ממשיכים לרשום ל-DB.
function isQuietHours() {
  const from = (getSetting('alert_quiet_from') || '').trim();  // e.g. "02:00"
  const to   = (getSetting('alert_quiet_to')   || '').trim();  // e.g. "08:00"
  if (!from || !to) return false;

  const now  = new Date();
  const cur  = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const start = fh * 60 + fm;
  const end   = th * 60 + tm;

  return start <= end ? (cur >= start && cur < end)   // e.g. 02:00-08:00
                      : (cur >= start || cur < end);  // e.g. 22:00-06:00 (חוצה חצות)
}

// שלח מייל התראה.
//
// חשוב: הפונקציה הזו נקראת מתוך לולאת ה-polling. היא לעולם לא תחזיק
// את הקורא — כשל SMTP או DNS תלוי היה מקפיא את סריקת כל שאר המכשירים
// ומפיל את הניטור כולו בגלל בעיה במייל.
function sendAlertEmail(subject, body) {
  if (Date.now() < _smtpFailedUntil) return Promise.resolve();

  const transporter = createTransporter();
  if (!transporter) return Promise.resolve();

  const from       = getSetting('smtp_from')        || process.env.SMTP_FROM;
  const recipients = getSetting('alert_recipients') || process.env.ALERT_RECIPIENTS;
  if (!recipients) return Promise.resolve();

  transporter.sendMail({ from, to: recipients, subject, text: body })
    .then(() => {
      _smtpFailedUntil = 0;
      console.log(`[Alerts] מייל נשלח: ${subject}`);
    })
    .catch((err) => {
      _smtpFailedUntil = Date.now() + SMTP_BACKOFF_MS;
      console.error(`[Alerts] כשל בשליחת מייל (${err.message}). ` +
                    `משהה ניסיונות ל-${SMTP_BACKOFF_MS / 60000} דקות.`);
    })
    .finally(() => { try { transporter.close(); } catch {} });

  // לא ממתינים לתוצאה — הניטור ממשיך
  return Promise.resolve();
}

// בנה קישור ישיר למכשיר בממשק (אם app_base_url מוגדר)
function deviceLink(deviceId) {
  const base = (getSetting('app_base_url') || '').trim().replace(/\/$/, '');
  return base ? `\nקישור: ${base}/devices/${deviceId}` : '';
}

// קישור ישיר לפורט ספציפי (גולל ומדגיש את הפורט)
function portLink(deviceId, ifIndex) {
  const base = (getSetting('app_base_url') || '').trim().replace(/\/$/, '');
  return base ? `\nקישור לפורט: ${base}/devices/${deviceId}?port=${ifIndex}` : '';
}

// בדוק metrics של מכשיר וצור התראה אם חצה סף
async function checkThresholds(device, metrics) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // טען pragim לכל מכשיר ואת ברירת המחדל הגלובלית
  const thresholds = db.prepare(`
    SELECT metric, threshold_pct, enabled
    FROM alert_thresholds
    WHERE (device_id = ? OR device_id IS NULL) AND enabled = 1
    ORDER BY device_id DESC  -- מכשיר ספציפי מנצח גלובלי
  `).all(device.id);

  // בנה map של metric -> threshold_pct (הראשון שנמצא הוא הספציפי ביותר)
  const threshMap = {};
  for (const t of thresholds) {
    if (!(t.metric in threshMap)) {
      threshMap[t.metric] = t.threshold_pct;
    }
  }

  const maxBps = getMaxBps(device);
  const checks = [
    { metric: 'bandwidth_in',  value: metrics.total_in_bps,  maxBps, label: 'תעבורה נכנסת כוללת' },
    { metric: 'bandwidth_out', value: metrics.total_out_bps, maxBps, label: 'תעבורה יוצאת כוללת' },
    { metric: 'cpu',           value: metrics.cpu_pct,  maxBps: 100, label: 'CPU' },
    { metric: 'mem',           value: metrics.mem_pct,  maxBps: 100, label: 'זיכרון' },
  ];

  for (const check of checks) {
    if (check.value == null || !(check.metric in threshMap)) continue;

    const pct = check.metric.startsWith('bandwidth')
      ? (check.value / (check.maxBps || 1)) * 100
      : check.value;

    const threshold = threshMap[check.metric];
    const key = `${device.id}_${check.metric}`;

    if (pct < threshold) {
      breachCount.delete(key); // ספייק נעלם — אפס מונה
      continue;
    }

    // ספור pollים עוקבים מעל הסף
    const consecutive = (breachCount.get(key) || 0) + 1;
    breachCount.set(key, consecutive);
    if (consecutive < SUSTAINED_POLLS_REQUIRED) continue; // עדיין לא מספיק

    const lastSent = lastAlertSent.get(key) || 0;
    if (now - lastSent < ALERT_COOLDOWN_SEC) continue;

    // מצא את הפורט הכי עמוס עבור התראות bandwidth
    let topPortDetail = '';
    if (check.metric.startsWith('bandwidth')) {
      const bpsCol = check.metric === 'bandwidth_out' ? 'out_bps' : 'in_bps';
      const topPort = db.prepare(`
        SELECT if_name, if_descr, if_alias, if_speed, ${bpsCol} AS bps
        FROM ports
        WHERE device_id = ? AND oper_status = 'up' AND if_speed > 0 AND ${bpsCol} > 0
        ORDER BY ${bpsCol} DESC LIMIT 1
      `).get(device.id);

      if (topPort) {
        const portName = topPort.if_alias || topPort.if_name || topPort.if_descr || 'Port?';
        const portPct  = Math.round((topPort.bps / topPort.if_speed) * 100);
        topPortDetail  = ` | פורט: ${portName} (${portPct}%)`;
      }
    }

    const message = `${device.name || device.ip} — ${check.label}: ${Math.round(pct)}%${topPortDetail} (סף: ${threshold}%)`;

    db.prepare(`
      INSERT INTO alert_events (device_id, metric, value, threshold, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(device.id, check.metric, Math.round(pct * 10) / 10, threshold, message);

    lastAlertSent.set(key, now);

    await sendAlertEmail(
      `[NetMonitor] התראה: ${device.name || device.ip} — ${check.label} ${Math.round(pct)}%`,
      `מכשיר: ${device.name || device.ip} (${device.ip})\n` +
      `מטריקה: ${check.label}\n` +
      `ערך: ${Math.round(pct)}%\n` +
      `סף: ${threshold}%\n` +
      (topPortDetail ? `פורט הכי עמוס:${topPortDetail.replace(' | פורט: ', ' ')}\n` : '') +
      `זמן: ${new Date().toLocaleString('he-IL')}` +
      deviceLink(device.id)
    );
  }

  // התראות per-port — כל פורט פעיל עם מהירות ידועה נבדק בנפרד
  await checkPortThresholds(device, threshMap, now);
}

async function checkPortThresholds(device, threshMap, now) {
  const db = getDb();
  if (threshMap['bandwidth_in'] == null && threshMap['bandwidth_out'] == null) return;

  const ports = db.prepare(`
    SELECT if_index, if_name, if_descr, if_alias, if_speed, in_bps, out_bps
    FROM ports
    WHERE device_id = ? AND oper_status = 'up' AND if_speed > 0
  `).all(device.id);

  // טען כל ה-overrides הייעודיים לפורטים של מכשיר זה בבת אחת
  const portOverrideRows = db.prepare(`
    SELECT port_if_index, metric, threshold_pct
    FROM alert_thresholds
    WHERE device_id = ? AND port_if_index IS NOT NULL AND enabled = 1
  `).all(device.id);
  const portOverrides = {};
  for (const r of portOverrideRows) {
    if (!portOverrides[r.port_if_index]) portOverrides[r.port_if_index] = {};
    portOverrides[r.port_if_index][r.metric] = r.threshold_pct;
  }

  const devLabel = device.name || device.ip;

  for (const port of ports) {
    const portLabel = port.if_alias || port.if_name || port.if_descr || `Port ${port.if_index}`;
    const po = portOverrides[port.if_index] || {};

    // סף ייעודי לפורט מנצח את סף המכשיר/גלובלי
    const inThresh  = po['bandwidth_in']  ?? threshMap['bandwidth_in'];
    const outThresh = po['bandwidth_out'] ?? threshMap['bandwidth_out'];

    const portChecks = [
      { dir: 'out', bps: port.out_bps, threshold: outThresh, label: 'תעבורה יוצאת',  metric: 'port_bandwidth_out' },
      { dir: 'in',  bps: port.in_bps,  threshold: inThresh,  label: 'תעבורה נכנסת', metric: 'port_bandwidth_in'  },
    ];

    for (const pc of portChecks) {
      if (pc.threshold == null || pc.bps == null) continue;
      const pct = (pc.bps / port.if_speed) * 100;
      const key = `${device.id}_port_${port.if_index}_${pc.dir}`;

      if (pct < pc.threshold) {
        breachCount.delete(key); // ספייק נעלם — אפס מונה
        continue;
      }

      // ספור pollים עוקבים מעל הסף
      const consecutive = (breachCount.get(key) || 0) + 1;
      breachCount.set(key, consecutive);
      if (consecutive < SUSTAINED_POLLS_REQUIRED) continue;

      const lastSent = lastAlertSent.get(key) || 0;
      if (now - lastSent < ALERT_COOLDOWN_SEC) continue;

      const msg = `${devLabel} — פורט ${portLabel} [${port.if_index}]: ${pc.label} ${Math.round(pct)}% (סף: ${pc.threshold}%)`;
      db.prepare(`
        INSERT INTO alert_events (device_id, metric, value, threshold, message, port_if_index)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(device.id, pc.metric, Math.round(pct * 10) / 10, pc.threshold, msg, port.if_index);

      lastAlertSent.set(key, now);

      await sendAlertEmail(
        `[NetMonitor] פורט עמוס: ${devLabel} — ${portLabel}`,
        `מכשיר: ${devLabel} (${device.ip})\n` +
        `פורט: ${portLabel} [if_index: ${port.if_index}]\n` +
        `מטריקה: ${pc.label}\n` +
        `ערך: ${Math.round(pct)}%\n` +
        `סף: ${pc.threshold}%\n` +
        `זמן: ${new Date().toLocaleString('he-IL')}` +
        portLink(device.id, port.if_index)
      );
    }
  }
}

// סך קיבולת bandwidth של המכשיר (bps) — סכום כל הפורטים הפיזיים הפעילים.
// Bridge-Aggregation ו-Eth-Trunk הם ממשקים לוגיים שמסכמים פורטים פיזיים;
// כללתם יגרום לספירה כפולה מול total_out_bps שמסכם אותם.
function getMaxBps(device) {
  const db = getDb();
  const row = db.prepare(`
    SELECT SUM(if_speed) AS total_speed FROM ports
    WHERE device_id = ? AND oper_status = 'up' AND if_speed > 0
      AND if_name NOT LIKE 'Bridge-Aggregation%'
      AND if_name NOT LIKE 'Eth-Trunk%'
      AND if_name NOT LIKE 'Port-Channel%'
      AND if_name NOT LIKE 'LAG%'
  `).get(device.id);
  return row?.total_speed || (1000 * 1000 * 1000); // ברירת מחדל 1Gbps
}

// רשום התראת DOWN לפי סטטוס
async function checkDeviceDown(device) {
  if (device.status !== 'down') return;

  const db = getDb();
  const key = `${device.id}_status`;
  const now = Math.floor(Date.now() / 1000);
  const lastSent = lastAlertSent.get(key) || 0;

  if (now - lastSent < ALERT_COOLDOWN_SEC) return;

  // בדוק שאין כבר event פתוח (resolved_at IS NULL)
  const existing = db.prepare(`
    SELECT id FROM alert_events
    WHERE device_id = ? AND metric = 'status' AND resolved_at IS NULL
    LIMIT 1
  `).get(device.id);

  if (existing) return;

  db.prepare(`
    INSERT INTO alert_events (device_id, metric, value, threshold, message)
    VALUES (?, 'status', 0, 1, ?)
  `).run(device.id, `${device.name || device.ip} ירד מהרשת (DOWN)`);

  lastAlertSent.set(key, now);

  if (isQuietHours()) {
    console.log(`[Alerts] שעות שקט — SNMP DOWN לא נשלח: ${device.name || device.ip}`);
    return;
  }

  await sendAlertEmail(
    `[NetMonitor] מכשיר DOWN: ${device.name || device.ip}`,
    `מכשיר: ${device.name || device.ip} (${device.ip})\n` +
    `סטטוס: DOWN — לא מגיב ל-SNMP\n` +
    `זמן: ${new Date().toLocaleString('he-IL')}` +
    deviceLink(device.id)
  );
}

// סגור event DOWN כשמכשיר חוזר UP ושלח מייל אישור
function resolveDeviceDown(device) {
  const db = getDb();
  db.prepare(`
    UPDATE alert_events
    SET resolved_at = unixepoch()
    WHERE device_id = ? AND metric = 'status' AND resolved_at IS NULL
  `).run(device.id);

  // נקה cooldown
  lastAlertSent.delete(`${device.id}_status`);
}

module.exports = { checkThresholds, checkDeviceDown, resolveDeviceDown, sendAlertEmail };
