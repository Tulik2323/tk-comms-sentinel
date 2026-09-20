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
const signMain   = (payload, expiresIn = '8h') =>
  jwt.sign(payload, mainSecret(), { algorithm: ALG, expiresIn, jwtid: crypto.randomBytes(16).toString('hex') });
const signTemp   = (payload, expiresIn)         => jwt.sign(payload, tempSecret(), { algorithm: ALG, expiresIn });
const verifyMain = (token) => jwt.verify(token, mainSecret(), { algorithms: [ALG] });
const verifyTemp = (token) => jwt.verify(token, tempSecret(), { algorithms: [ALG] });

module.exports = { signMain, signTemp, verifyMain, verifyTemp };
