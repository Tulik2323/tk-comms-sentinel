// scripts/set-local-password.js — קובע סיסמה לחשבון מקומי (חשבון חירום)
//
// שימוש:  node scripts/set-local-password.js <username>
//
// הסיסמה נקראת מהמקלדת ולא מארגומנט — ארגומנטים נשמרים בהיסטוריית
// ה-shell וגלויים ברשימת התהליכים לכל משתמש בשרת.
// .env: TKCS_DATA_DIR when set (מבנה מגורס), אחרת backend\ (מבנה שטוח) —
// ראה ההערה המקבילה ב-seed-admin.js.
const path = require('path');
require('dotenv').config({ path: path.join(process.env.TKCS_DATA_DIR || path.join(__dirname, '..'), '.env') });

const bcrypt     = require('bcryptjs');
const { initDb } = require('../db/database');
const { passwordProblem } = require('../services/passwords');

const username   = process.argv[2];

function fail(msg) {
  console.error('שגיאה: ' + msg);
  process.exit(1);
}

// --- קריאה מ-stdin מוזרם (לא מסוף) ---
// באפר משותף לכל הקריאות: מקטע יחיד עשוי להכיל את שתי השורות, ובלעדיו
// הקריאה הראשונה בולעת גם את השנייה.
let _buf = '', _ended = false, _waiter = null, _pipedInit = false;

function _pump() {
  if (!_waiter) return;
  const i = _buf.indexOf('\n');
  if (i !== -1) {
    const line = _buf.slice(0, i).replace(/\r$/, '');
    _buf = _buf.slice(i + 1);
    const w = _waiter; _waiter = null;
    process.stdout.write('\n');
    w.resolve(line);
  } else if (_ended) {
    const w = _waiter; _waiter = null;
    process.stdout.write('\n');
    if (_buf.length) { const line = _buf.replace(/\r?\n$/, ''); _buf = ''; w.resolve(line); }
    else w.reject(new Error('הקלט הסתיים לפני שהתקבלה סיסמה'));
  }
}

function _initPiped() {
  if (_pipedInit) return;
  _pipedInit = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { _buf += c; _pump(); });
  process.stdin.on('end',  ()  => { _ended = true; _pump(); });
  process.stdin.resume();
}

// קריאת סיסמה. במסוף אמיתי מסתיר בכוכביות; ב-stdin מוזרם קורא שורה.
// מבטיח שה-promise תמיד נפתר או נדחה — גרסה קודמת נתקעה בשקט על
// stdin סגור ויצאה בקוד 0 בלי לשמור דבר.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);

    if (!stdin.isTTY) {
      _initPiped();
      _waiter = { resolve, reject };
      _pump();
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let pw = '';
    const finish = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onChunk);
      process.stdout.write('\n');
      fn(arg);
    };

    const onChunk = (chunk) => {
      // הדבקה מגיעה כמקטע אחד — עוברים תו-תו
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') return finish(resolve, pw);
        if (ch === '') return finish(() => process.exit(130));   // Ctrl+C
        if (ch === '' || ch === '\b') {
          if (pw.length) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch >= ' ') { pw += ch; process.stdout.write('*'); }
      }
    };

    stdin.on('data', onChunk);
  });
}

(async () => {
  if (!username) {
    console.error('שימוש: node scripts/set-local-password.js <username>');
    process.exit(1);
  }

  const db   = await initDb();
  const user = db.prepare('SELECT username, role FROM user_accounts WHERE username = ?').get(username);
  if (!user) fail(`המשתמש "${username}" לא קיים ב-user_accounts.`);

  const pw1 = await askHidden(`סיסמה חדשה עבור ${username} (${user.role}): `);
  const problem = passwordProblem(pw1, username);
  if (problem) fail(`${problem}. לא בוצע שינוי.`);

  const pw2 = await askHidden('הקלד שוב לאימות: ');
  if (pw1 !== pw2) fail('הסיסמאות אינן תואמות. לא בוצע שינוי.');

  const hash = await bcrypt.hash(pw1, 12);
  // token_valid_after: החלפת סיסמה מבטלת כל התחברות פתוחה של החשבון (גם של מי שהשתמש בסיסמה הישנה)
  const res  = db.prepare('UPDATE user_accounts SET password_hash = ?, token_valid_after = unixepoch() WHERE username = ?')
                 .run(hash, username);
  if (res.changes !== 1) fail(`העדכון לא בוצע (changes=${res.changes}).`);

  // קריאה חוזרת ואימות בפועל — אחרת אין ערובה שהסיסמה באמת עובדת
  const saved = db.prepare('SELECT password_hash FROM user_accounts WHERE username = ?').get(username);
  if (!saved?.password_hash || !(await bcrypt.compare(pw1, saved.password_hash))) {
    fail('הסיסמה נשמרה אך לא עברה אימות חוזר. בדוק את מסד הנתונים.');
  }

  console.log(`\n✓ הסיסמה של ${username} עודכנה ואומתה.`);
  process.exit(0);
})().catch((e) => fail(e.message));
