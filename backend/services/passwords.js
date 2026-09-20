// services/passwords.js — מדיניות סיסמאות לחשבונות מקומיים, ובדיקת סיסמה שמסתירה אם המשתמש קיים

const bcrypt = require('bcryptjs');

const MIN_LENGTH = 12;
const MAX_BYTES  = 72;    // bcrypt מתעלם ממה שאחרי 72 בייטים, ולכן סיסמה ארוכה יותר לא מוסיפה הגנה

const COMMON = new Set([
  'password1234', 'password12345', 'passw0rd1234', 'administrator', 'administrator1', 'qwertyuiop12',
  'qwerty123456', '123456789012', '1234567890ab', 'letmein12345', 'welcome12345', 'changeme1234',
  'admin1234567', 'iloveyou1234', 'abcdefghijkl', 'aaaaaaaaaaaa', '111111111111',
]);

// מחזיר הודעת שגיאה (בעברית), או '' כשהסיסמה עומדת במדיניות
function passwordProblem(password, username = '') {
  if (typeof password !== 'string') return 'הסיסמה חייבת להיות טקסט';
  if (password.length < MIN_LENGTH)  return `הסיסמה חייבת להכיל לפחות ${MIN_LENGTH} תווים`;
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return `הסיסמה ארוכה מדי (מקסימום ${MAX_BYTES} בייטים)`;
  if (COMMON.has(password.toLowerCase())) return 'הסיסמה נפוצה מדי';
  if (new Set(password).size < 5)     return 'הסיסמה חוזרת על עצמה מדי';
  const u = String(username || '').trim().toLowerCase();
  if (u.length >= 3 && password.toLowerCase().includes(u)) return 'הסיסמה לא יכולה להכיל את שם המשתמש';
  // סיסמה קצרה (עד 15 תווים) חייבת לערבב סוגי תווים; משפט ארוך מספיק גם בלי זה
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(re => re.test(password)).length;
  if (password.length < 16 && classes < 3) {
    return 'סיסמה של פחות מ-16 תווים חייבת לשלב לפחות שלושה מתוך: אותיות קטנות, גדולות, ספרות וסימנים';
  }
  return '';
}

// bcrypt.compare מול hash קבוע, כדי ששם משתמש לא קיים ייכשל באותו זמן כמו סיסמה שגויה.
// בלי זה זמן התגובה חושף אילו שמות משתמש קיימים.
const DUMMY_HASH = bcrypt.hashSync('tkcs-dummy-password-for-timing', 12);
async function burnCompare(password) {
  try { await bcrypt.compare(String(password || ''), DUMMY_HASH); } catch (_) {}
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

module.exports = { passwordProblem, burnCompare, USERNAME_RE, MIN_LENGTH };
