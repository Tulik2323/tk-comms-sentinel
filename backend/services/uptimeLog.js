// services/uptimeLog.js — היסטוריית נפילות ואתחולים של מכשירים
//
// device_outages: שורה לכל נפילה. started_at הוא הכשל הראשון בסדרה, confirmed_at הוא הרגע שבו הכשל
//   השלישי ברצף אישר אותה (אותו סף כמו התראת DOWN), ו-ended_at הוא ה-poll המוצלח הראשון אחריה.
//   path_outage=1 מסמן נפילה שהתרחשה כשכל הסבב נפל יחד (תקלת נתיב, לא תקלה של המכשיר).
// device_reboots: ירידה ב-sysUpTime בין שני polls רצופים.
//
// ההיסטוריה מתחילה ברגע השחרור (uptime_tracking_since): את העבר אי אפשר לשחזר, כי alert_events נסגר
// ידנית או אוטומטית ולכן משכי הזמן שלו אינם משכי נפילה אמיתיים.
const { getDb, getSetting } = require('../db/database');

const RETENTION_DAYS = 180;
// sysUpTime הוא מונה 32 סיביות של מאיות שנייה ועוטף אחרי ~497 ימים. מכשיר שהיה למעלה מ-486 יום
// ואז "ירד" ל-uptime קטן כנראה עטף ולא אותחל, ולכן אין רושמים אותו כאתחול.
const UPTIME_WRAP_GUARD_SEC = 42_000_000;
// נפילות נתיב שהתחילו במרווח קטן מזה זו מזו מוצגות כאירוע אחד
const PATH_CLUSTER_GAP_SEC = 900;

// deviceId -> זמן הכשל הראשון בסדרת הכשלונות הנוכחית (בזיכרון: אחרי ריסטארט של ה-poller הסדרה מתחילה מחדש)
const failStart = new Map();

// נקרא מ-poller בכל כשל. fails = מספר הכשלונות הרצופים, threshold = הסף שמאשר נפילה.
function noteFailure(deviceId, fails, threshold, now) {
  if (fails === 1 || !failStart.has(deviceId)) failStart.set(deviceId, now);
  if (fails < threshold) return;
  const db = getDb();
  const open = db.prepare('SELECT id FROM device_outages WHERE device_id = ? AND ended_at IS NULL').get(deviceId);
  if (open) return;   // נפילה פתוחה קיימת (למשל מלפני ריסטארט של ה-poller)
  db.prepare('INSERT INTO device_outages (device_id, started_at, confirmed_at) VALUES (?, ?, ?)')
    .run(deviceId, failStart.get(deviceId) ?? now, now);
}

// נקרא מ-poller כשמכשיר שהיה DOWN ענה. סוגר את הנפילה הפתוחה.
function noteRecovery(deviceId, now) {
  failStart.delete(deviceId);
  getDb().prepare('UPDATE device_outages SET ended_at = ? WHERE device_id = ? AND ended_at IS NULL').run(now, deviceId);
}

// נקרא מ-poller בכל poll מוצלח. prevUptime הוא ה-uptime_sec שנשמר ב-poll הקודם.
function noteUptime(deviceId, prevUptime, newUptime, now) {
  if (prevUptime == null || newUptime == null) return;
  if (prevUptime >= UPTIME_WRAP_GUARD_SEC) return;
  if (newUptime + 10 >= prevUptime) return;   // 10 שניות סובלנות לרעש
  getDb().prepare(
    'INSERT INTO device_reboots (device_id, detected_at, booted_at, prev_uptime_sec, new_uptime_sec) VALUES (?, ?, ?, ?, ?)'
  ).run(deviceId, now, now - newUptime, prevUptime, newUptime);
}

// הסבב זיהה שכל המכשירים נפלו יחד: הנפילות שאושרו בסבב הזה הן נפילת נתיב
function markPathOutage(deviceIds, cycleStartSec) {
  if (!deviceIds.length) return;
  const db = getDb();
  const stmt = db.prepare(
    'UPDATE device_outages SET path_outage = 1 WHERE device_id = ? AND ended_at IS NULL AND confirmed_at >= ? AND path_outage = 0'
  );
  for (const id of deviceIds) stmt.run(id, cycleStartSec);
}

function pruneUptimeLog() {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  db.prepare('DELETE FROM device_outages WHERE ended_at IS NOT NULL AND started_at < ?').run(cutoff);
  db.prepare('DELETE FROM device_reboots WHERE detected_at < ?').run(cutoff);
}

// ---- שאילתות ל-Dashboard ----

const nowSec = () => Math.floor(Date.now() / 1000);

// מאז מתי יש נתונים. נקבע פעם אחת, בהפעלה הראשונה של הגרסה הזו.
function trackingSince() {
  const v = parseInt(getSetting('uptime_tracking_since'), 10);
  return Number.isFinite(v) ? v : nowSec();
}

const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };

// נפילות בטווח (כולל נפילות שהתחילו לפניו ועדיין נמשכות בו). נפילות נתיב מקובצות לאירוע אחד.
function getOutages(range) {
  const db    = getDb();
  const now   = nowSec();
  const since = now - RANGES[range];

  const rows = db.prepare(`
    SELECT o.id, o.device_id, o.started_at, o.confirmed_at, o.ended_at, o.path_outage,
           d.name, d.ip
    FROM device_outages o JOIN devices d ON d.id = o.device_id
    WHERE COALESCE(o.ended_at, ?) >= ?
    ORDER BY o.started_at DESC
  `).all(now, since);

  const events = [];
  const pathRows = [];
  for (const r of rows) {
    if (r.path_outage) { pathRows.push(r); continue; }
    events.push({
      kind: 'device', device_id: r.device_id, name: r.name || r.ip, ip: r.ip,
      started_at: r.started_at, ended_at: r.ended_at,
      duration_sec: (r.ended_at ?? now) - r.started_at, ongoing: r.ended_at == null,
    });
  }

  // נפילות נתיב: לאשכל כל מה שהתחיל בטווח של PATH_CLUSTER_GAP_SEC אחד מהשני
  pathRows.sort((a, b) => a.started_at - b.started_at);
  const clusters = [];
  for (const r of pathRows) {
    const c = clusters[clusters.length - 1];
    if (c && r.started_at - c.lastStart <= PATH_CLUSTER_GAP_SEC) {
      c.rows.push(r); c.lastStart = r.started_at;
    } else {
      clusters.push({ rows: [r], lastStart: r.started_at });
    }
  }
  for (const c of clusters) {
    const started = Math.min(...c.rows.map(r => r.started_at));
    const ongoing = c.rows.some(r => r.ended_at == null);
    const ended   = ongoing ? null : Math.max(...c.rows.map(r => r.ended_at));
    events.push({
      kind: 'path', started_at: started, ended_at: ended,
      duration_sec: (ended ?? now) - started, ongoing,
      device_count: c.rows.length,
      devices: c.rows.slice(0, 100).map(r => ({ device_id: r.device_id, name: r.name || r.ip, ip: r.ip })),
    });
  }
  events.sort((a, b) => b.started_at - a.started_at);

  return {
    range, since, now, tracking_since: trackingSince(),
    summary: {
      events:         events.length,
      device_events:  events.filter(e => e.kind === 'device').length,
      path_events:    events.filter(e => e.kind === 'path').length,
      ongoing:        events.filter(e => e.ongoing).length,
      devices_affected: new Set(rows.filter(r => !r.path_outage).map(r => r.device_id)).size,
    },
    events,
  };
}

// שניות של השבתה של מכשיר בתוך [from, to], לפי רשימת נפילות (בלי נפילות נתיב)
function downSeconds(intervals, from, to) {
  let total = 0;
  for (const [s, e] of intervals) {
    const a = Math.max(s, from), b = Math.min(e, to);
    if (b > a) total += b - a;
  }
  return total;
}

// זמינות באחוזים לחלון של days ימים. נמדדת רק מאז שיש נתונים (tracking_since או יצירת המכשיר),
// ואם עבר פחות משעה מאז, אין עדיין מה לדווח (null).
function availabilityPct(intervals, days, createdAt, since, now) {
  const from = Math.max(now - days * 86400, since, createdAt || 0);
  const span = now - from;
  if (span < 3600) return null;
  return Math.max(0, Math.min(100, 100 * (1 - downSeconds(intervals, from, now) / span)));
}

// שורה לכל מכשיר: זמן פעילות, אתחול אחרון, זמינות ל-7 ול-30 ימים
function getUptimeOverview() {
  const db    = getDb();
  const now   = nowSec();
  const since = trackingSince();

  const devices = db.prepare('SELECT id, name, ip, status, uptime_sec, created_at FROM devices ORDER BY name, ip').all();

  const outageRows = db.prepare(`
    SELECT device_id, started_at, COALESCE(ended_at, ?) AS e, path_outage
    FROM device_outages WHERE COALESCE(ended_at, ?) >= ?
  `).all(now, now, now - 30 * 86400);
  const byDevice = new Map();
  const counts30 = new Map();
  for (const r of outageRows) {
    counts30.set(r.device_id, (counts30.get(r.device_id) || 0) + 1);
    if (r.path_outage) continue;   // נפילת נתיב אינה תקלה של המכשיר, ולכן לא נספרת נגד הזמינות שלו
    if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, []);
    byDevice.get(r.device_id).push([r.started_at, r.e]);
  }

  const rebootRows = db.prepare(`
    SELECT device_id, COUNT(*) AS n, MAX(booted_at) AS last_booted
    FROM device_reboots WHERE detected_at >= ? GROUP BY device_id
  `).all(now - 30 * 86400);
  const reboots = new Map(rebootRows.map(r => [r.device_id, r]));

  return {
    now, tracking_since: since,
    devices: devices.map(d => {
      const iv = byDevice.get(d.id) || [];
      const rb = reboots.get(d.id);
      return {
        id: d.id, name: d.name || d.ip, ip: d.ip, status: d.status,
        uptime_sec: d.status === 'down' ? null : d.uptime_sec,
        booted_at:  d.status !== 'down' && d.uptime_sec != null ? now - d.uptime_sec : null,
        avail_7d:   availabilityPct(iv, 7,  d.created_at, since, now),
        avail_30d:  availabilityPct(iv, 30, d.created_at, since, now),
        outages_30d: counts30.get(d.id) || 0,
        reboots_30d: rb ? rb.n : 0,
      };
    }),
  };
}

// יומן אחד למכשיר: נפילות ואתחולים, מהחדש לישן
function getDeviceLog(deviceId) {
  const db  = getDb();
  const now = nowSec();
  const d = db.prepare('SELECT id, name, ip, status, uptime_sec FROM devices WHERE id = ?').get(deviceId);
  if (!d) return null;

  const outages = db.prepare(`
    SELECT started_at, ended_at, path_outage FROM device_outages
    WHERE device_id = ? ORDER BY started_at DESC LIMIT 200
  `).all(deviceId).map(o => ({
    type: 'outage', at: o.started_at, ended_at: o.ended_at, path: !!o.path_outage,
    duration_sec: (o.ended_at ?? now) - o.started_at, ongoing: o.ended_at == null,
  }));
  const reboots = db.prepare(`
    SELECT detected_at, booted_at, prev_uptime_sec, new_uptime_sec FROM device_reboots
    WHERE device_id = ? ORDER BY detected_at DESC LIMIT 200
  `).all(deviceId).map(r => ({
    type: 'reboot', at: r.booted_at, detected_at: r.detected_at, prev_uptime_sec: r.prev_uptime_sec,
  }));

  const events = [...outages, ...reboots].sort((a, b) => b.at - a.at).slice(0, 200);
  const ov = getUptimeOverview().devices.find(x => x.id === deviceId);
  return {
    now, tracking_since: trackingSince(),
    device: { id: d.id, name: d.name || d.ip, ip: d.ip, status: d.status },
    uptime_sec: ov?.uptime_sec ?? null, booted_at: ov?.booted_at ?? null,
    avail_7d: ov?.avail_7d ?? null, avail_30d: ov?.avail_30d ?? null,
    events,
  };
}

// הסוויצ'ים הכי חמים לפי הקריאה הגבוהה ביותר מבין החיישנים שלהם.
// מכשיר DOWN לא מדורג: הקריאה האחרונה שלו ישנה. מכשיר בלי יצרן מוכר (למשל חומת אש) אינו סוויץ' ולא נספר.
const TEMP_WARN = 45;
const TEMP_CRIT = 60;

function getHottest(limit) {
  const rows = getDb().prepare('SELECT id, name, ip, status, vendor, model, hw_status FROM devices').all();
  const ranked = [];
  const noData = [];
  let down = 0;
  for (const r of rows) {
    if (!r.vendor) continue;
    if (r.status === 'down') { down++; continue; }
    let temps = [];
    try { temps = JSON.parse(r.hw_status || 'null')?.temps || []; } catch (_) {}
    const values = temps.map(t => t.celsius).filter(c => Number.isFinite(c));
    if (!values.length) { noData.push({ id: r.id, name: r.name || r.ip, ip: r.ip, model: r.model }); continue; }
    ranked.push({
      id: r.id, name: r.name || r.ip, ip: r.ip, model: r.model,
      celsius: Math.max(...values), sensors: values.length,
    });
  }
  ranked.sort((a, b) => b.celsius - a.celsius);
  return {
    warn: TEMP_WARN, crit: TEMP_CRIT,
    items: ranked.slice(0, limit),
    measured: ranked.length,
    no_data: noData.length, no_data_devices: noData.slice(0, 100),
    down,
  };
}

module.exports = {
  noteFailure, noteRecovery, noteUptime, markPathOutage, pruneUptimeLog,
  getOutages, getUptimeOverview, getDeviceLog, getHottest, RANGES,
};
