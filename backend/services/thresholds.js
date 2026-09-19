// services/thresholds.js — כללים משותפים לסף ההתראות: מגבלות, ולידציה וכתיבה.
// משמש את מנוע ההתראות (alerts.js), את נתיבי /api/alerts ואת נתיבי הסף-לפורט בדף המכשיר.
//
// סף גלובלי וסף למכשיר יושבים ב-alert_thresholds. סף ייעודי לפורט יושב ב-alert_port_thresholds:
// הטבלה הראשונה נוצרה עם UNIQUE(device_id, metric), ואילוץ ברמת הטבלה אי אפשר להסיר ב-SQLite
// בלי לבנות אותה מחדש, והוא חוסם כמה ספי פורט על אותו מכשיר. העמודה alert_thresholds.port_if_index
// נשארת מהעבר ואינה בשימוש.

// כמה דקות ערך חייב להישאר מעל הסף לפני שנשלחת התראה. 5 הוא מה שהיה עד 1.4.0
// (שני pollים ברצף כשהמרווח הוא 5 דקות).
const DEFAULT_DURATION_MIN = 5;
const MAX_DURATION_MIN     = 1440;   // 24 שעות

// המטריקות שהמנוע באמת בודק. מטריקה אחרת הייתה נשמרת ולא עושה כלום.
const DEVICE_METRICS = ['bandwidth_in', 'bandwidth_out', 'cpu', 'mem'];
const PORT_METRICS   = ['bandwidth_in', 'bandwidth_out'];

// אחוז סף: מספר בין 1 ל-100, אחרת null
function parsePct(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
}

// משך בדקות. value: undefined = השדה לא נשלח, null = נשלח ריק, אחרת מספר שלם 0..1440.
function parseDuration(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_MIN) return { ok: false };
  return { ok: true, value: n };
}

// יוצר או מעדכן סף גלובלי (deviceId = null) או סף למכשיר.
// duration: undefined = לא לגעת בשורה קיימת (ובשורה חדשה — ברירת המחדל), null = ברירת המחדל.
function saveThreshold(db, { deviceId, metric, pct, duration, enabled }) {
  const en  = enabled ? 1 : 0;
  const dur = duration === null ? DEFAULT_DURATION_MIN : duration;

  db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM alert_thresholds WHERE device_id IS ? AND port_if_index IS NULL AND metric = ?'
    ).get(deviceId, metric);

    if (existing && dur === undefined) {
      db.prepare('UPDATE alert_thresholds SET threshold_pct = ?, enabled = ? WHERE id = ?')
        .run(pct, en, existing.id);
    } else if (existing) {
      db.prepare('UPDATE alert_thresholds SET threshold_pct = ?, enabled = ?, duration_min = ? WHERE id = ?')
        .run(pct, en, dur, existing.id);
    } else if (dur === undefined) {
      db.prepare('INSERT INTO alert_thresholds (device_id, metric, threshold_pct, enabled) VALUES (?, ?, ?, ?)')
        .run(deviceId, metric, pct, en);
    } else {
      db.prepare('INSERT INTO alert_thresholds (device_id, metric, threshold_pct, enabled, duration_min) VALUES (?, ?, ?, ?, ?)')
        .run(deviceId, metric, pct, en, dur);
    }
  })();
}

// יוצר או מעדכן סף ייעודי לפורט. duration = null: המשך עובר בירושה מסף המכשיר/הגלובלי.
function savePortThreshold(db, { deviceId, ifIndex, metric, pct, duration }) {
  db.prepare(`
    INSERT INTO alert_port_thresholds (device_id, if_index, metric, threshold_pct, duration_min, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(device_id, if_index, metric) DO UPDATE SET
      threshold_pct = excluded.threshold_pct,
      duration_min  = excluded.duration_min,
      enabled       = 1
  `).run(deviceId, ifIndex, metric, pct, duration === undefined ? null : duration);
}

module.exports = {
  DEFAULT_DURATION_MIN, MAX_DURATION_MIN, DEVICE_METRICS, PORT_METRICS,
  parsePct, parseDuration, saveThreshold, savePortThreshold,
};
