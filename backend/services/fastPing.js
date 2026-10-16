// services/fastPing.js — זיהוי נפילה/התאוששות מהיר, עצמאי מה-polling המלא
//
// ה-SNMP polling הרגיל (poller.js) בודק כל מכשיר לפי poll_interval_sec שלו (ברירת
// מחדל 300 שניות). נפילה קצרה שמתחילה ומסתיימת בין שני polls עוקבים נשארת בלתי
// נראית לגמרי — לא רק בלי התראה, אלא בלי שום רישום שהיא בכלל קרתה. זו בדיוק התקרית
// מ-2026-10-14: סוויץ' נפל לכ-60 שניות, בדיוק בפער של כ-6.5 דקות
// בין שני polls, ולא נראה שום רישום בשום מקום.
//
// הפתרון כאן: בדיקת ICMP ping קלה לכל המכשירים כל 20 שניות, עצמאית לגמרי מה-SNMP
// polling. ping לא בודק את תקינות ה-SNMP עצמו (רק הגעה ברמת הרשת), ולכן זה לא מחליף
// את ה-polling המלא — רק מצמצם את חלון העיוורון לנפילה/חזרה מכמה דקות לכמה עשרות
// שניות. סף של כשלונות/הצלחות רצופים (PING_FAIL_THRESHOLD) מונע הכרזת DOWN על בסיס
// חבילת ping בודדת שאבדה.
const { execFile } = require('child_process');
const cron = require('node-cron');
const { getDb } = require('../db/database');
const { checkDeviceDown, resolveDeviceDown } = require('./alerts');
const { noteFailure, noteRecovery } = require('./uptimeLog');
const { logAudit } = require('../db/audit');
const { deviceLabel } = require('../lib/deviceLabel');

const PING_TIMEOUT_MS     = 800;
const PING_FAIL_THRESHOLD = 2;   // כשלונות ping רצופים לפני הכרזת DOWN (~40 שניות בקצב הבדיקה כאן)
const PING_CONCURRENCY    = 10;

// deviceId -> מספר כשלונות ping רצופים. נפרד מהמונה המקביל ב-poller.js (SNMP) —
// שני המסלולים עצמאיים ומטרתם שונה (זיהוי מהיר מול איסוף מדדים מלא).
const pingFailCount = new Map();

// deviceId -> True אם ראינו ל-ping הצלחה אחת לפחות מאז הפעלת התהליך. חלק מהמכשירים
// (למשל חומת אש עם מדיניות שחוסמת ICMP) אף פעם לא עונים ל-ping למרות שהם תקינים
// לגמרי מבחינת SNMP — בלי השומר הזה, מכשיר כזה היה מוכרז DOWN כל כמה שניות על בסיס
// ping בלבד. מכשיר שמעולם לא נראתה לו תגובת ping מוצלח לא יוכרז DOWN דרך המסלול הזה.
const pingEverOk = new Set();

let _cycleRunning = false;

function pingHost(ip) {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '1', '-w', String(PING_TIMEOUT_MS), ip],
      { timeout: PING_TIMEOUT_MS + 1000 },
      (err) => resolve(!err));
  });
}

async function handleResult(device, ok) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  if (ok) {
    pingEverOk.add(device.id);
    pingFailCount.delete(device.id);
    if (device.status !== 'down') return;

    db.prepare("UPDATE devices SET status = 'up' WHERE id = ?").run(device.id);
    try { noteRecovery(device.id, now); }
    catch (e) { console.warn(`[FastPing] סגירת נפילה נכשלה עבור ${device.ip}: ${e.message}`); }
    try { resolveDeviceDown({ ...device, status: 'up' }); }
    catch (e) { console.warn(`[FastPing] resolveDeviceDown נכשל עבור ${device.ip}: ${e.message}`); }
    logAudit('info', 'poller', 'device_back_online',
      { device: deviceLabel(device) }, { device_id: device.id, ip: device.ip });
    return;
  }

  const fails = (pingFailCount.get(device.id) || 0) + 1;
  pingFailCount.set(device.id, fails);
  if (!pingEverOk.has(device.id)) return; // ICMP כנראה חסום למכשיר הזה — אין בסיס להכריע DOWN על פיו
  if (device.status === 'down') return;   // כבר מסומן (על ידי כאן או על ידי ה-SNMP poller) — אל תכפיל טיפול

  // נקרא כבר בכשל הראשון, כדי ששעת ההתחלה של הנפילה תהיה הכשל הראשון ולא רגע האישור
  try { noteFailure(device.id, fails, PING_FAIL_THRESHOLD, now); }
  catch (e) { console.warn(`[FastPing] רישום נפילה נכשל עבור ${device.ip}: ${e.message}`); }
  if (fails < PING_FAIL_THRESHOLD) return;

  db.prepare("UPDATE devices SET status = 'down' WHERE id = ?").run(device.id);
  console.warn(`[FastPing] ${device.ip} DOWN (ping ${fails}/${PING_FAIL_THRESHOLD})`);
  logAudit('warn', 'poller', 'device_unresponsive',
    { device: deviceLabel(device), why: 'ICMP ping לא נענה', error: 'ping timeout' },
    { device_id: device.id, ip: device.ip });
  try { await checkDeviceDown({ ...device, status: 'down' }); }
  catch (e) { console.warn(`[FastPing] checkDeviceDown נכשל עבור ${device.ip}: ${e.message}`); }
}

async function runPingCycle() {
  if (_cycleRunning) return;
  _cycleRunning = true;
  try {
    const devices = getDb().prepare('SELECT id, name, sys_name, ip, status FROM devices').all();
    if (devices.length === 0) return;

    let idx = 0;
    const worker = async () => {
      while (idx < devices.length) {
        const device = devices[idx++];
        const ok = await pingHost(device.ip).catch(() => false);
        await handleResult(device, ok).catch(e =>
          console.error(`[FastPing] שגיאה בטיפול בתוצאה עבור ${device.ip}: ${e.message}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PING_CONCURRENCY, devices.length) }, worker));
  } catch (e) {
    console.error('[FastPing] שגיאה בסבב:', e.message);
  } finally {
    _cycleRunning = false;
  }
}

function startFastPing() {
  console.log('[FastPing] מתחיל בדיקת ping מהירה (כל 20 שניות, כל המכשירים)');
  cron.schedule('*/20 * * * * *', runPingCycle);
}

module.exports = { startFastPing, runPingCycle };
