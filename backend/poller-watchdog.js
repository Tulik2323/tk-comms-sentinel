// poller-watchdog.js — שומר עצמאי על ה-poller. רץ כל 5 דקות ממשימה מתוזמנת נפרדת
// ("NetMonitor Watchdog", נרשמת עם tools\register-poller-watchdog.ps1), ויוצא מיד.
//
// למה עוד שומר: ב-22/10/2026 הדיסק התמלא, ה-poller מת, וכל הפעלה מחדש נכשלה במשך 11.5
// שעות — בלי שום התראה. התראת "הניטור הפסיק" מתהליך ה-web לא מספיקה לבד: IIS עוצר את
// תהליך האתר כשאף אחד לא פותח אותו. השומר הזה לא תלוי לא ב-poller ולא באתר:
//   1. heartbeat ישן מ-5 דקות → התראה (טלגרם + מייל), פעם אחת לכל הפסקה.
//   2. תהליך poller שקיים אבל לא מעדכן heartbeat (תקוע) → נסגר, כדי שהמשימה תפעיל אותו מחדש.
//   3. מקום פנוי נמוך בדיסק → התראה (גם כשה-poller לא רץ).
// פותח את מסד הנתונים לקריאה בלבד: חייב לעבוד גם כשהדיסק מלא.
//
// אחרי אתחול שרת (22/10/2026 13:45) השומר רץ מיד, קרא heartbeat ישן מלפני האתחול, ובזמן
// שבדק תהליכים (כ-30 שניות בשרת שרק עלה) ה-poller עלה — והשומר סגר אותו ושלח "הניטור
// הפסיק" שקרי. לכן: לא פועלים ב-10 הדקות הראשונות אחרי אתחול, לא סוגרים poller צעיר
// מ-5 דקות, וקוראים את ה-heartbeat שוב רגע לפני כל פעולה.
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const dataDirForEnv = process.env.TKCS_DATA_DIR || __dirname;
require('dotenv').config({ path: path.join(dataDirForEnv, '.env') });

const { openDbReadOnly, getSetting } = require('./db/database');

const STALE_SEC          = 300;
const BOOT_GRACE_SEC     = 600;   // אחרי אתחול שרת: השירותים עדיין עולים
const MIN_KILL_AGE_SEC   = Number(process.env.TKCS_WD_MIN_KILL_AGE) || 300;   // poller שעלה עכשיו לא נחשב תקוע
const STATE_FILE  = path.join(__dirname, 'logs', 'watchdog-state.json');
const log = (...a) => console.log(`[${new Date().toLocaleString('en-GB')}] [Watchdog]`, ...a);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeState(st) {
  // כשהדיסק מלא הכתיבה נכשלת, וההתראה תחזור בכל ריצה (כל 5 דקות) עד שיתפנה מקום — מכוון
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st));
  } catch (_) { /* ממשיכים בלי מצב */ }
}

// כמה זמן השרת למעלה, ותהליכי node שמריצים את poller-service.js של ההתקנה הזו (לפי הנתיב
// המלא בשורת הפקודה) עם הגיל שלהם, בשניות.
function systemSnapshot() {
  const target = path.join(__dirname, 'poller-service.js');
  const ps = [
    '$now = Get-Date',
    "'BOOT ' + [int]($now - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${target}*' } | ` +
      "ForEach-Object { 'PID ' + $_.ProcessId + ' ' + [int]($now - $_.CreationDate).TotalSeconds }",
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const boot = /BOOT (\d+)/.exec(out);
    const procs = [...out.matchAll(/PID (\d+) (\d+)/g)].map(m => ({ pid: Number(m[1]), ageSec: Number(m[2]) }));
    return { bootAgeSec: boot ? Number(boot[1]) : null, procs };
  } catch (_) {
    return { bootAgeSec: null, procs: [] };
  }
}

async function main() {
  openDbReadOnly();
  const { monitorStatus, diskStatus, sendSystemAlert } = require('./services/systemHealth');
  const st = readState();
  const now = Math.floor(Date.now() / 1000);
  const fmt = (ts) => new Date(ts * 1000).toLocaleString('he-IL');

  let m = monitorStatus();
  let stale = m.heartbeat && m.age_sec > STALE_SEC;

  if (stale) {
    const snap = systemSnapshot();
    if (snap.bootAgeSec !== null && snap.bootAgeSec < BOOT_GRACE_SEC) {
      log(`השרת עלה לפני ${snap.bootAgeSec} שניות — ממתין שהשירותים יעלו`);
      return;
    }
    // הבדיקה של התהליכים לוקחת זמן: קוראים את ה-heartbeat שוב לפני שפועלים
    m = monitorStatus();
    stale = m.heartbeat && m.age_sec > STALE_SEC;
  }

  if (stale) {
    const snap = systemSnapshot();
    const stuck = snap.procs.filter(p => p.ageSec >= MIN_KILL_AGE_SEC);
    const young = snap.procs.filter(p => p.ageSec < MIN_KILL_AGE_SEC);
    if (young.length) {
      log(`heartbeat ישן ${m.age_sec} שניות, אבל ה-poller עלה לפני ${young[0].ageSec} שניות — ממתין`);
    } else if (stuck.length) {
      // קיים אבל לא מעדכן: תקוע. סגירה מאפשרת למשימה המתוזמנת להפעיל עותק חדש תוך דקה.
      log(`heartbeat ישן ${m.age_sec} שניות, תהליכי poller תקועים: ${stuck.map(p => p.pid).join(', ')} — סוגר`);
      for (const p of stuck) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { log(`סגירת ${p.pid} נכשלה: ${e.message}`); } }
    } else {
      log(`heartbeat ישן ${m.age_sec} שניות ואין תהליך poller (ההפעלה נכשלת)`);
    }
    // poller צעיר: נותנים לו לעלות, בלי התראה. אם תהליך ה-web כבר התריע (מפתח ב-DB), לא שולחים שוב.
    if (!young.length && !st.downAlertedAt && !(Number(getSetting('monitor_down_alerted_at')) || 0)) {
      sendSystemAlert('הניטור הפסיק לעבוד',
        `תהליך הניטור לא פעיל מאז ${fmt(m.heartbeat)}.\n` +
        `עד שיחזור: המתגים לא נבדקים, לא נשלחות התראות, והנתונים במסך אינם עדכניים.\n` +
        (stuck.length ? 'התהליך היה תקוע ונסגר; המשימה המתוזמנת תפעיל אותו מחדש.\n'
                      : 'התהליך לא רץ, וההפעלה שלו נכשלת. סיבה נפוצה: דיסק מלא.\n'));
      st.downAlertedAt = now;
    }
  } else {
    // הודעת "חזר לפעול" נשלחת מה-poller עצמו כשהוא עולה אחרי הפסקה (reportStartupGap)
    st.downAlertedAt = 0;
  }

  const d = diskStatus();
  if (d && d.low && now - (st.diskAlertedAt || 0) > 6 * 3600) {
    sendSystemAlert('מקום פנוי נמוך בדיסק של שרת הניטור',
      `בדיסק של שרת הניטור נשארו ${d.free_gb}GB פנויים (${d.free_pct}%).\n` +
      `כשהדיסק מתמלא, הניטור מפסיק לעבוד ולא נשלחות התראות. יש לפנות מקום בהקדם.`);
    st.diskAlertedAt = now;
  } else if (d && !d.low) {
    st.diskAlertedAt = 0;
  }

  writeState(st);
  // לתת למייל ולטלגרם זמן לצאת לפני היציאה
  await new Promise(r => setTimeout(r, 15000));
}

main().then(() => process.exit(0)).catch((e) => { log('שגיאה:', e.message); process.exit(1); });
