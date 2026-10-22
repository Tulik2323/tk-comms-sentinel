// poller-service.js — ה-poller כתהליך עצמאי, מחוץ ל-iisnode
//
// למה בנפרד: iisnode ממחזר תהליכי worker לפי עומס ו-idle timeout, ולכן
// לולאת ה-polling הייתה נקטעת ומתחילה מחדש בלי קשר למצב הרשת. תהליך
// ייעודי מריץ אותה ברציפות. הכתיבה למסד בטוחה במקביל ל-web מאז המעבר
// ל-node:sqlite (נעילות OS + WAL) — ראה db/database.js.
//
// .env נטען ממיקום קבוע (לא cwd) — ראה ההערה המקבילה ב-server.js לגבי
// TKCS_DATA_DIR ומבנה versions\ המגורס.
const path = require('path');
const dataDirForEnv = process.env.TKCS_DATA_DIR || __dirname;
require('dotenv').config({ path: path.join(dataDirForEnv, '.env') });

// חותמת זמן לכל שורה בלוג. בלעדיה אי אפשר היה לדעת מתי ה-poller הפסיק לעבוד (22/10/2026).
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const d = new Date();
    const ts = `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB')}`;
    orig(`[${ts}]`, ...args);
  };
}

const { initDb }      = require('./db/database');
const { startPoller } = require('./services/poller');

// כשל בשלב ה-init חייב להרעיש: אחרת השירות "רץ" בלי לנטר כלום
process.on('unhandledRejection', (err) => {
  console.error('[Poller] unhandledRejection:', err?.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Poller] uncaughtException:', err?.stack || err);
  process.exit(1);
});

// תהליך תקוע (22/10/2026: 18 דקות בלי פעולה, מחזיק נעילה על מסד הנתונים) נסגר על ידי
// השומר החיצוני poller-watchdog.js לפי ה-heartbeat. שומר בתוך התהליך נבדק ונפסל: ה-thread
// שלו קפא יחד עם הלולאה הראשית.

// מסד נתונים נעול בהפעלה (תהליך אחר באמצע כתיבה או שחזור WAL גדול) — מנסים שוב במקום ליפול
async function initDbWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try { return await initDb(); }
    catch (err) {
      if (!/locked|busy/i.test(err.message) || attempt >= 24) throw err;
      console.warn(`[Poller] מסד הנתונים נעול (ניסיון ${attempt}) — מנסה שוב בעוד 5 שניות`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

(async () => {
  await initDbWithRetry();
  startPoller();

  console.log(`
╔═══════════════════════════════════════════╗
║      NetMonitor Poller — שירות עצמאי      ║
╚═══════════════════════════════════════════╝`);
  console.log(`[Poller] PID ${process.pid} — פועל`);
})();
