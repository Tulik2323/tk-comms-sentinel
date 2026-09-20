// middleware/rateLimit.js — הגבלת ניסיונות כושלים של התחברות ושל אימות 2FA
//
// נספרים רק ניסיונות שנכשלו. עד 1.4.3 נספר כל ניסיון וכניסה מוצלחת אפסה את המונה, ולכן מי שמחזיק
// חשבון תקין יכול היה לאפס אותו בין ניחושים על חשבון אחר. כאן כניסה מוצלחת מאפסת רק את המונה של
// אותו שם משתמש, ולא את המונה של הכתובת.
//
// המונים בזיכרון התהליך (ולכן מתאפסים באתחול), ולפי שם משתמש וגם לפי כתובת: כתובת לבדה לא תופסת
// ניחושים מכתובות רבות, ושם משתמש לבד לא תופס ניחושים על חשבונות רבים.

const { normalizeIp } = require('../db/audit');

class FailureCounter {
  constructor(max, windowMs) {
    this.max      = max;
    this.windowMs = windowMs;
    this.map      = new Map(); // key -> { count, resetAt }
  }

  _entry(key) {
    const e = this.map.get(key);
    if (e && Date.now() > e.resetAt) { this.map.delete(key); return undefined; }
    return e;
  }

  isBlocked(key)  { const e = this._entry(key); return Boolean(e) && e.count >= this.max; }

  retryAfterSec(key) {
    const e = this._entry(key);
    return e ? Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000)) : 0;
  }

  // מחזיר את מספר הכשלונות אחרי ההוספה
  fail(key) {
    const e = this._entry(key) || { count: 0, resetAt: Date.now() + this.windowMs };
    e.count++;
    this.map.set(key, e);
    return e.count;
  }

  reset(key) { this.map.delete(key); }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (now > e.resetAt) this.map.delete(k);
  }
}

const WINDOW_MS = 15 * 60 * 1000;

const loginByIp   = new FailureCounter(10, WINDOW_MS);   // ניסיונות סיסמה כושלים מאותה כתובת
const loginByUser = new FailureCounter(10, WINDOW_MS);   // ...ואותו שם משתמש, מכל כתובת
const twofaByUser = new FailureCounter(5,  WINDOW_MS);   // קודי 2FA שגויים לאותו משתמש
const twofaByIp   = new FailureCounter(20, WINDOW_MS);   // ...ומאותה כתובת

// קוד TOTP שכבר נוצל תקף עוד כ-90 שניות; בלי זה אפשר להשתמש בקוד שנצפה שוב ושוב בחלון שלו
const usedCodes = new Map(); // "username:code" -> expiresAt
const CODE_TTL_MS = 90 * 1000;

function clientIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress)) || 'unknown';
}

function normUser(u) {
  return typeof u === 'string' ? u.trim().toLowerCase().slice(0, 64) : '';
}

function blockedMessage(sec) {
  return `יותר מדי ניסיונות כושלים. נסה שוב בעוד ${sec} שניות.`;
}

// middleware לפני /login: חוסם בלי לבדוק סיסמה כשהכתובת או שם המשתמש כבר חרגו
function loginRateLimit(req, res, next) {
  const ip   = clientIp(req);
  const user = normUser(req.body && req.body.username);
  const ipBlocked   = loginByIp.isBlocked(ip);
  const userBlocked = user && loginByUser.isBlocked(user);
  if (ipBlocked || userBlocked) {
    const sec = Math.max(ipBlocked ? loginByIp.retryAfterSec(ip) : 0, userBlocked ? loginByUser.retryAfterSec(user) : 0);
    res.set('Retry-After', String(sec));
    return res.status(429).json({ error: blockedMessage(sec) });
  }
  next();
}

// ניסיון התחברות כושל. מחזיר true כשהניסיון הזה הוא זה שגרם לחסימה (כדי לרשום אותה פעם אחת)
function recordLoginFailure(req, username) {
  const ip = clientIp(req);
  const user = normUser(username);
  const a = loginByIp.fail(ip);
  const b = user ? loginByUser.fail(user) : 0;
  return a === loginByIp.max || b === loginByUser.max;
}

// כניסה מוצלחת (שלב הסיסמה): מאפסת רק את המונה של שם המשתמש
function recordLoginSuccess(username) {
  loginByUser.reset(normUser(username));
}

// ---- 2FA ----
function twofaBlockedSec(req, username) {
  const ip = clientIp(req);
  const user = normUser(username);
  const sec = Math.max(twofaByIp.isBlocked(ip) ? twofaByIp.retryAfterSec(ip) : 0,
                       twofaByUser.isBlocked(user) ? twofaByUser.retryAfterSec(user) : 0);
  return sec; // 0 = לא חסום
}

function recordTwofaFailure(req, username) {
  const a = twofaByIp.fail(clientIp(req));
  const b = twofaByUser.fail(normUser(username));
  return a === twofaByIp.max || b === twofaByUser.max;
}

function recordTwofaSuccess(username) {
  twofaByUser.reset(normUser(username));
}

// האם הקוד הזה כבר שימש? אם לא, רושם אותו כמנוצל
function consumeCode(username, code) {
  const now = Date.now();
  const key = `${normUser(username)}:${String(code).trim()}`;
  const exp = usedCodes.get(key);
  if (exp && exp > now) return false;
  usedCodes.set(key, now + CODE_TTL_MS);
  return true;
}

setInterval(() => {
  loginByIp.sweep(); loginByUser.sweep(); twofaByIp.sweep(); twofaByUser.sweep();
  const now = Date.now();
  for (const [k, exp] of usedCodes) if (exp <= now) usedCodes.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = {
  loginRateLimit, recordLoginFailure, recordLoginSuccess,
  twofaBlockedSec, recordTwofaFailure, recordTwofaSuccess, consumeCode,
  blockedMessage, clientIp,
  // לבדיקות
  __test: { loginByIp, loginByUser, twofaByIp, twofaByUser, usedCodes },
};
