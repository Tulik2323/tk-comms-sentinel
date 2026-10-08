// services/tokens.js — הנפקה ואימות של טוקני JWT (מקור אחד לכל השרת)
//
// * האלגוריתם נעול ל-HS256 גם בחתימה וגם באימות, כך שטוקן שנחתם באלגוריתם אחר לא מתקבל.
// * טוקן הביניים (setupOnly / 2fa_required) נחתם בסוד נפרד. אם JWT_TEMP_SECRET לא הוגדר הוא
//   נגזר מ-JWT_SECRET ב-HMAC. עד 1.4.3 הוא נבנה כ-JWT_SECRET + '_temp', ובלי JWT_SECRET זה
//   היה הסוד הקבוע "undefined_temp".
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const ALG = 'HS256';

function mainSecret() {
  return process.env.JWT_SECRET;
}

function tempSecret() {
  if (process.env.JWT_TEMP_SECRET) return process.env.JWT_TEMP_SECRET;
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET)).update('tkcs-temp-token-v1').digest('hex');
}

// jwtid: מזהה ייחודי לכל טוקן, כדי שיציאה תבטל את הטוקן הזה בלבד ולא את שאר ההתחברויות של המשתמש
// משך ההתחברות לפי משתמש (user_accounts.session_hours). משתמש של מסך בקרה צריך שההתחברות תחזיק ימים,
// ובלי הגדרה כולם מקבלים 8 שעות כמו תמיד. רק הערכים ברשימה מתקבלים, כדי שערך שגוי לא ייצור טוקן לנצח.
const SESSION_HOURS_ALLOWED = [8, 24, 168, 720, 8760];
const SESSION_HOURS_DEFAULT = 8;
function sessionExpiry(username) {
  let hours = SESSION_HOURS_DEFAULT;
  try {
    const row = require('../db/database').getDb()
      .prepare('SELECT session_hours FROM user_accounts WHERE username = ?').get(username);
    if (row && SESSION_HOURS_ALLOWED.includes(row.session_hours)) hours = row.session_hours;
  } catch (_) {}
  return hours + 'h';
}

const signMain   = (payload, expiresIn = '8h') =>
  jwt.sign(payload, mainSecret(), { algorithm: ALG, expiresIn, jwtid: crypto.randomBytes(16).toString('hex') });
const signTemp   = (payload, expiresIn)         => jwt.sign(payload, tempSecret(), { algorithm: ALG, expiresIn });
const verifyMain = (token) => jwt.verify(token, mainSecret(), { algorithms: [ALG] });
const verifyTemp = (token) => jwt.verify(token, tempSecret(), { algorithms: [ALG] });

module.exports = { SESSION_HOURS_ALLOWED, sessionExpiry, signMain, signTemp, verifyMain, verifyTemp };
