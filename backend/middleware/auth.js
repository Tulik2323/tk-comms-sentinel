// middleware/auth.js — בדיקת JWT בכל בקשה מוגנת
const jwt = require('jsonwebtoken');

const TEMP_SECRET = () => process.env.JWT_TEMP_SECRET || process.env.JWT_SECRET + '_temp';

// מחלץ JWT מה-header ומוודא שהוא תקף.
// דוחה בפירוש setupOnly tokens — אלה מותרים רק ל-setup-2fa / confirm-2fa.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.setupOnly) {
      return res.status(403).json({ error: 'נדרשת הגדרת 2FA לפני כניסה למערכת', setupRequired: true });
    }
    req.user = payload; // { username, role, iat, exp }
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
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch {}

  // נסה setupOnly token
  try {
    const payload = jwt.verify(token, TEMP_SECRET());
    if (!payload.setupOnly) return res.status(401).json({ error: 'Token לא תקף' });
    req.user = payload;
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
