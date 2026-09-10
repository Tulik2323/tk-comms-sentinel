// poller-service.js — ה-poller כתהליך עצמאי, מחוץ ל-iisnode
//
// למה בנפרד: iisnode ממחזר תהליכי worker לפי עומס ו-idle timeout, ולכן
// לולאת ה-polling הייתה נקטעת ומתחילה מחדש בלי קשר למצב הרשת. תהליך
// ייעודי מריץ אותה ברציפות. הכתיבה למסד בטוחה במקביל ל-web מאז המעבר
// ל-node:sqlite (נעילות OS + WAL) — ראה db/database.js.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

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

(async () => {
  await initDb();
  startPoller();

  console.log(`
╔═══════════════════════════════════════════╗
║      NetMonitor Poller — שירות עצמאי      ║
╚═══════════════════════════════════════════╝`);
  console.log(`[Poller] PID ${process.pid} — פועל`);
})();
