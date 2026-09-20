// scripts/seed-admin.js — יצירת חשבון admin ראשון
// הרצה: node scripts/seed-admin.js <username> <password>
//
// .env נטען מ-TKCS_DATA_DIR כשהוא מוגדר (מבנה מגורס, data\ משותפת), אחרת
// נופל ל-backend\ (מבנה שטוח ישן) — כמו server.js/poller-service.js. בלי זה
// הסקריפט מוצא .env לא-קיים בשקט, DB_PATH חוזר לברירת מחדל, וה-admin נוצר
// ב-DB שונה מזה שהשרת האמיתי קורא ממנו.
const path = require('path');
require('dotenv').config({ path: path.join(process.env.TKCS_DATA_DIR || path.join(__dirname, '..'), '.env') });

const bcrypt = require('bcryptjs');
const { initDb } = require('../db/database');
const { passwordProblem, USERNAME_RE } = require('../services/passwords');

const [,, username, password, role = 'admin'] = process.argv;

if (!username || !password) {
  console.error('שימוש: node scripts/seed-admin.js <username> <password> [admin|viewer]');
  process.exit(1);
}
// אותם כללים כמו ביצירת משתמש דרך ה-API: הסקריפט הזה הוא הדרך היחידה ליצור אדמין ראשון, ולכן סיסמה חלשה כאן
// היא סיסמה חלשה לחשבון החזק ביותר במערכת
if (!USERNAME_RE.test(username)) {
  console.error('שגיאה: שם משתמש יכול להכיל אותיות באנגלית, ספרות ואת הסימנים . _ @ - בלבד (עד 64 תווים)');
  process.exit(1);
}
if (role !== 'admin' && role !== 'viewer') {
  console.error('שגיאה: התפקיד חייב להיות admin או viewer');
  process.exit(1);
}
{
  const problem = passwordProblem(password, username);
  if (problem) {
    console.error(`שגיאה: ${problem}`);
    process.exit(1);
  }
}

async function main() {
  const db   = await initDb();
  const hash = await bcrypt.hash(password, 12);

  try {
    // token_valid_after: יצירה מחדש של חשבון קיים (תיקון התקנה) מבטלת כל התחברות פתוחה שלו
    db.prepare(`
      INSERT OR REPLACE INTO user_accounts (username, password_hash, role, token_valid_after)
      VALUES (?, ?, ?, unixepoch())
    `).run(username, hash, role);

    console.log(`✓ משתמש '${username}' (${role}) נוצר בהצלחה`);
    console.log(`  כניסה: http://localhost:3001 עם ${username}`);
  } catch (err) {
    console.error('שגיאה:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

main();

