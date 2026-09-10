// scripts/seed-admin.js — יצירת חשבון admin ראשון
// הרצה: node scripts/seed-admin.js <username> <password>
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { initDb } = require('../db/database');

const [,, username, password, role = 'admin'] = process.argv;

if (!username || !password) {
  console.error('שימוש: node scripts/seed-admin.js <username> <password> [admin|viewer]');
  process.exit(1);
}

async function main() {
  const db   = await initDb();
  const hash = await bcrypt.hash(password, 12);

  try {
    db.prepare(`
      INSERT OR REPLACE INTO user_accounts (username, password_hash, role)
      VALUES (?, ?, ?)
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

