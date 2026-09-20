// services/smtp.js — אימות תעודת TLS מול שרת הדואר (משותף להתראות, לדוחות ולבדיקת SMTP)
//
// עד 1.4.3 האימות היה כבוי תמיד, כך שמי שנמצא בדרך יכול היה ליירט את סיסמת ה-SMTP ואת תוכן ההתראות.
// ההגדרה smtp_tls_verify: '1' = תמיד מאמתים, '0' = לעולם לא (שרת דואר פנימי עם תעודה עצמית),
// ריק = אוטומטי: מאמתים כשנשלחים פרטי כניסה, כי בלי אימות אפשר לגנוב אותם, ולא מאמתים כשהשרת
// פתוח בלי כניסה. כך שרת דואר פנימי בלי סיסמה ממשיך לעבוד, ומי שהגדיר סיסמה מקבל הגנה.
const { getSetting } = require('../db/database');

function tlsVerify() {
  const v = String(getSetting('smtp_tls_verify') || '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return Boolean(getSetting('smtp_user') || process.env.SMTP_USER);
}

function tlsOptions() {
  return { rejectUnauthorized: tlsVerify() };
}

module.exports = { tlsVerify, tlsOptions };
