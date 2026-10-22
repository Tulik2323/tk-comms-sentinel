// services/systemHealth.js — בריאות מערכת הניטור עצמה
//
// הרקע (2026-10-21/22): הדיסק של השרת התמלא (קבצים זמניים של תוכנה אחרת), תהליך
// ה-poller מת בשקט, וכל ניסיון להפעיל אותו מחדש נכשל מיד. 11.5 שעות לא נבדק אף מתג,
// מתגים אותחלו בלי שום התראה, והממשק המשיך להציג נתונים ישנים כאילו הם עדכניים.
// מה שחסר: המערכת לא ידעה לדווח על עצמה. כאן:
//   1. heartbeat — ה-poller כותב "אני חי" בכל סבב ping (20 שניות).
//   2. בדיקת מקום פנוי בדיסק של מסד הנתונים, עם התראה לפני שהוא מתמלא.
//   3. התראת מערכת (מייל + טלגרם) שלא תלויה בבחירת סוגי ההתראות.
const fs   = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('../db/database');

const HEARTBEAT_KEY      = 'poller_heartbeat';
const STALE_AFTER_SEC    = 180;                 // 3 דקות בלי heartbeat = הניטור לא פועל
const DISK_MIN_FREE_GB   = 10;
const DISK_MIN_FREE_PCT  = 5;
const DISK_REALERT_SEC   = 6 * 3600;

const nowSec = () => Math.floor(Date.now() / 1000);

function beat() {
  try { setSetting(HEARTBEAT_KEY, String(nowSec())); }
  catch (e) { console.warn(`[Health] כתיבת heartbeat נכשלה: ${e.message}`); }
}

function monitorStatus() {
  const hb  = Number(getSetting(HEARTBEAT_KEY)) || null;
  const age = hb ? nowSec() - hb : null;
  return { heartbeat: hb, age_sec: age, stale: age === null || age > STALE_AFTER_SEC };
}

// מקום פנוי בכונן של מסד הנתונים. statfs קיים ב-Node 18.15 ומעלה; בלעדיו מחזירים null.
function diskStatus() {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'netmonitor.db');
    const st = fs.statfsSync(path.dirname(path.resolve(dbPath)));
    const free  = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    const freeGb = free / 1024 ** 3;
    const pct    = total ? (free / total) * 100 : 100;
    return { free_gb: Math.round(freeGb * 10) / 10, free_pct: Math.round(pct * 10) / 10,
             low: freeGb < DISK_MIN_FREE_GB || pct < DISK_MIN_FREE_PCT };
  } catch (_) {
    return null;
  }
}

// התראת מערכת: נשלחת בטלגרם ובמייל גם אם הסוג לא סומן ברשימת סוגי ההתראות, כי היא
// אומרת שהניטור עצמו בסכנה. שעות השקט חלות על המייל כרגיל; טלגרם לא כפוף להן.
function sendSystemAlert(subject, text) {
  // require מאוחר: alerts.js טוען את database ו-telegram, ונטען גם מכאן
  const { sendAlertEmail, isQuietHoursNow } = require('./alerts');
  const { sendTelegram } = require('./telegram');
  sendTelegram('system', text).catch(() => {});
  if (!isQuietHoursNow()) sendAlertEmail(`[NetMonitor] ${subject}`, text);
}

let _diskMemAt = 0;
// נקרא מה-poller בכל סבב. התראה כשהמקום יורד מתחת לסף, ושוב כל 6 שעות כל עוד הוא נמוך.
function checkDisk() {
  const d = diskStatus();
  if (!d) return;
  const last = Math.max(Number(getSetting('disk_low_alerted_at')) || 0, _diskMemAt);
  if (d.low) {
    if (nowSec() - last < DISK_REALERT_SEC) return;
    _diskMemAt = nowSec();
    try { setSetting('disk_low_alerted_at', String(nowSec())); } catch (_) { /* הדיסק מלא — הזיכרון מספיק */ }
    console.warn(`[Health] מקום פנוי נמוך בדיסק: ${d.free_gb}GB (${d.free_pct}%)`);
    sendSystemAlert('מקום פנוי נמוך בדיסק של שרת הניטור',
      `בדיסק של שרת הניטור נשארו ${d.free_gb}GB פנויים (${d.free_pct}%).\n` +
      `כשהדיסק מתמלא, הניטור מפסיק לעבוד ולא נשלחות התראות. יש לפנות מקום בהקדם.\n` +
      `זמן: ${new Date().toLocaleString('he-IL')}`);
  } else if (last) {
    _diskMemAt = 0;
    try { setSetting('disk_low_alerted_at', ''); } catch (_) {}
  }
}

const fmtDuration = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} שעות ו-${m} דקות` : `${m} דקות`;
};
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('he-IL');

// נקרא מתהליך ה-web כל דקה: התראה כשה-poller הפסיק לפעול, והודעה כשחזר.
// המפתח ב-DB מונע כפילויות (גם בין כמה תהליכי web וגם אחרי הפעלה מחדש).
const ALERT_STALE_AFTER_SEC = 300;
// גיבוי בזיכרון למפתח ב-DB: כשהדיסק מלא, הכתיבה של המפתח נכשלת — ובלי הגיבוי ההתראה
// הייתה נשלחת מחדש בכל דקה
let _memAlertedAt = 0;
function watchMonitor() {
  const m = monitorStatus();
  if (!m.heartbeat) return;                       // התקנה חדשה: ה-poller עוד לא רץ אף פעם
  const alertedAt = Number(getSetting('monitor_down_alerted_at')) || 0;
  if (m.age_sec <= ALERT_STALE_AFTER_SEC) _memAlertedAt = 0;
  if (m.age_sec > ALERT_STALE_AFTER_SEC && !alertedAt && !_memAlertedAt) {
    _memAlertedAt = nowSec();
    try {
      setSetting('monitor_down_alerted_at', String(nowSec()));
      setSetting('poller_last_down_from', String(m.heartbeat));
    } catch (e) { console.warn(`[Health] שמירת מצב ההתראה נכשלה: ${e.message}`); }
    console.warn(`[Health] ה-poller לא פעיל מאז ${fmtTime(m.heartbeat)}`);
    sendSystemAlert('הניטור הפסיק לעבוד',
      `תהליך הניטור לא פעיל מאז ${fmtTime(m.heartbeat)}.\n` +
      `עד שיחזור: המתגים לא נבדקים, לא נשלחות התראות, והנתונים במסך אינם עדכניים.\n` +
      `בדקו את המשימה המתוזמנת NetMonitor Poller ואת המקום הפנוי בדיסק של השרת.`);
  } else if (m.age_sec <= ALERT_STALE_AFTER_SEC && alertedAt) {
    notifyMonitorResumed(alertedAt);
  }
}

// הודעת "חזר לפעול". נקראת מה-web כשה-heartbeat חוזר, ומה-poller בהפעלה אחרי הפסקה ארוכה —
// מי שמגיע ראשון שולח, והמפתח מתאפס.
function notifyMonitorResumed(downSinceHint) {
  const alertedAt = Number(getSetting('monitor_down_alerted_at')) || 0;
  if (!alertedAt) return;
  setSetting('monitor_down_alerted_at', '');
  const since = Number(getSetting('poller_last_down_from')) || downSinceHint || alertedAt;
  sendSystemAlert('הניטור חזר לפעול',
    `תהליך הניטור פועל שוב (${fmtTime(nowSec())}). הוא לא פעל מאז ${fmtTime(since)}.\n` +
    `אירועים מאותו זמן (נפילות קצרות) לא נתפסו. אתחולים של מתגים מזוהים בבדיקה הבאה של כל מתג.`);
}

// נקרא מה-poller בהפעלה: אם ה-heartbeat הקודם ישן, הייתה הפסקה בניטור — מדווחים עליה
// גם אם תהליך ה-web לא רץ באותה שעה ולא שלח את התראת ההפסקה.
const GAP_REPORT_SEC = 300;
function reportStartupGap() {
  const prev = Number(getSetting(HEARTBEAT_KEY)) || 0;
  if (!prev) return;
  const gap = nowSec() - prev;
  if (gap < GAP_REPORT_SEC) return;
  setSetting('poller_last_down_from', String(prev));
  if (Number(getSetting('monitor_down_alerted_at')) || 0) return notifyMonitorResumed(prev);
  sendSystemAlert('הניטור חזר לפעול אחרי הפסקה',
    `תהליך הניטור הופעל מחדש (${fmtTime(nowSec())}) אחרי הפסקה של ${fmtDuration(gap)} — מאז ${fmtTime(prev)}.\n` +
    `אירועים מאותו זמן (נפילות קצרות) לא נתפסו. אתחולים של מתגים מזוהים בבדיקה הבאה של כל מתג.`);
}

module.exports = { beat, monitorStatus, diskStatus, checkDisk, sendSystemAlert, watchMonitor, reportStartupGap, STALE_AFTER_SEC };
