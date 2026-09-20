// middleware/auth.js — בדיקת JWT בכל בקשה מוגנת
//
// טוקן תקף לא מספיק: בכל בקשה בודקים גם שהמשתמש עדיין קיים ב-user_accounts, ואת התפקיד לוקחים
// משם ולא מהטוקן. כך משתמש שנמחק או שהורד מ-admin מאבד את ההרשאות מיד ולא בעוד 8 שעות.
// token_valid_after מאפשר ביטול של כל הטוקנים שהונפקו לפני רגע מסוים (יציאה מהמערכת, החלפת סיסמה,
// איפוס 2FA, שינוי תפקיד).
const { getDb } = require('../db/database');
const { verifyMain, verifyTemp } = require('../services/tokens');

function loadUser(username) {
  try {
    return getDb().prepare('SELECT username, role, token_valid_after FROM user_accounts WHERE username = ?').get(username);
  } catch (_) {
    return null;
  }
}

function isRevoked(jti) {
  if (!jti) return false;   // טוקן שהונפק לפני 1.4.4 אין לו jti; אותו מבטלים רק דרך token_valid_after
  try {
    return Boolean(getDb().prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti));
  } catch (_) {
    return false;
  }
}

// מחזיר { user } אם הטוקן עדיין בתוקף מול ה-DB, אחרת { error }.
// token_valid_after נספר בשניות שלמות, ולכן טוקן שהונפק באותה שנייה שבה בוטלו הטוקנים עדיין נחשב תקף.
function checkAgainstDb(payload) {
  const u = loadUser(payload.username);
  if (!u) return { error: 'המשתמש אינו קיים במערכת, התחבר שוב' };
  if ((payload.iat || 0) < (u.token_valid_after || 0)) return { error: 'ההתחברות בוטלה, התחבר שוב' };
  if (isRevoked(payload.jti)) return { error: 'ההתחברות בוטלה, התחבר שוב' };
  return { user: { username: u.username, role: u.role, iat: payload.iat, exp: payload.exp, jti: payload.jti } };
}

// מחלץ JWT מה-header ומוודא שהוא תקף.
// דוחה בפירוש setupOnly tokens — אלה מותרים רק ל-setup-2fa / confirm-2fa.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyMain(token);
    if (payload.setupOnly) {
      return res.status(403).json({ error: 'נדרשת הגדרת 2FA לפני כניסה למערכת', setupRequired: true });
    }
    const checked = checkAgainstDb(payload);
    if (checked.error) return res.status(401).json({ error: checked.error });
    req.user = checked.user; // { username, role, iat }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'פג תוקף ההתחברות, התחבר שוב' });
    }
    return res.status(401).json({ error: 'Token לא תקף' });
  }
}

// מתיר גם setupOnly token (לendpoints של הגדרת 2FA)
function requireSetupOrAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }
  const token = authHeader.slice(7);

  // נסה JWT מלא קודם
  try {
    const payload = verifyMain(token);
    const checked = checkAgainstDb(payload);
    if (checked.error) return res.status(401).json({ error: checked.error });
    req.user = checked.user;
    return next();
  } catch {}

  // נסה setupOnly token
  try {
    const payload = verifyTemp(token);
    if (!payload.setupOnly) return res.status(401).json({ error: 'Token לא תקף' });
    const checked = checkAgainstDb(payload);
    if (checked.error) return res.status(401).json({ error: checked.error });
    req.user = { ...checked.user, setupOnly: true };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'פג תוקף — התחבר שוב' });
    }
    return res.status(401).json({ error: 'Token לא תקף' });
  }
}

// רק admin יכול לגשת
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'נדרשות הרשאות אדמין' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireSetupOrAuth };
