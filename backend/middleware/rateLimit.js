// middleware/rateLimit.js — הגבלת ניסיונות התחברות
// מונע brute-force: מקסימום 10 ניסיונות per IP ב-15 דקות
const attempts = new Map(); // ip -> { count, resetAt }

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 דקות

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = attempts.get(ip);

  // נקה entry ישן
  if (entry && now > entry.resetAt) {
    entry = null;
    attempts.delete(ip);
  }

  if (!entry) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_ATTEMPTS) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({
      error: `יותר מדי ניסיונות. נסה שוב בעוד ${waitSec} שניות.`
    });
  }

  next();
}

// איפוס counter אחרי login מוצלח
function resetAttempts(ip) {
  attempts.delete(ip);
}

// ניקוי entries ישנים כל 30 דקות
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts.entries()) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, 30 * 60 * 1000);

module.exports = { loginRateLimit, resetAttempts };
