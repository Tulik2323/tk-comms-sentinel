// routes/auth.js — login, 2FA, logout
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const speakeasy= require('speakeasy');
const qrcode   = require('qrcode');

const { getDb }                = require('../db/database');
const { authenticateAD }       = require('../services/ldap');
const { loginRateLimit, resetAttempts } = require('../middleware/rateLimit');
const { requireAuth, requireSetupOrAuth } = require('../middleware/auth');
const { logAudit }             = require('../db/audit');

const DEMO_MODE = process.env.DEMO_MODE === 'true';

// --- שלב 1: Login ---
// מאמת username+password (LDAP או local), מחזיר tempToken שדורש 2FA
router.post('/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });
  }

  const db = getDb();
  let role, displayName;

  try {
    // בדוק תחילה אם יש חשבון מקומי עם password_hash (חשבון חירום / demo)
    const localUser = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(username);
    const hasLocalPassword = localUser?.password_hash;

    if (DEMO_MODE || hasLocalPassword) {
      // אמות מול DB מקומי
      if (!localUser || !localUser.password_hash) {
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
      }
      const valid = await bcrypt.compare(password, localUser.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
      }
      role        = localUser.role;
      displayName = username;
    } else {
      // Production: LDAP/AD
      const result = await authenticateAD(username, password);
      role        = result.role;
      displayName = result.displayName || username;
    }
  } catch (err) {
    console.warn(`[Auth] כשל login ל-${username}: ${err.message}`);
    logAudit('warn', 'auth', `כשל התחברות: ${username} — ${err.message}`, { username, ip: req.ip });

    // סיסמה שגויה ותקלת תשתית הן לא אותו דבר. החזרת 401 גנרי על הכל
    // שלחה משתמשים לאפס את הסיסמה כשהבעיה הייתה חברות בקבוצה או DC למטה.
    switch (err.kind) {
      case 'forbidden':
        return res.status(403).json({ error: err.message });
      case 'config':
      case 'unavailable':
        return res.status(503).json({
          error: 'שירות האימות אינו זמין כרגע. פנה למנהל המערכת.',
          detail: err.message   // מוצג לאדמין, נרשם ב-audit
        });
      default:
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }
  }

  // ודא שקיים record ב-user_accounts (לשמירת TOTP)
  const existing = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(username);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_accounts (username, role) VALUES (?, ?)
    `).run(username, role);
  } else if (!DEMO_MODE && existing.role !== role) {
    // עדכן role לפי AD בכל login
    db.prepare('UPDATE user_accounts SET role = ? WHERE username = ?').run(role, username);
  }

  const userRecord = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(username);

  // אם אין TOTP מוגדר עדיין — תן setupOnly token מוגבל.
  // הטוקן הזה חתום על JWT_TEMP_SECRET ומותר רק ל-setup-2fa / confirm-2fa.
  // requireAuth דוחה אותו מיד, כך שאין גישה לשום endpoint אחר.
  if (!userRecord.totp_enabled) {
    const setupToken = jwt.sign(
      { username, role, setupOnly: true },
      process.env.JWT_TEMP_SECRET || process.env.JWT_SECRET + '_temp',
      { expiresIn: '15m' }
    );
    logAudit('info', 'auth', `התחברות: ${username} (${role}) — נדרשת הגדרת 2FA`, { username, ip: req.ip });
    resetAttempts(req.ip);
    return res.json({ setupToken, setupRequired: true, role, displayName });
  }

  // יש TOTP — תן tempToken שדורש verify
  const tempToken = jwt.sign(
    { username, role, step: '2fa_required' },
    process.env.JWT_TEMP_SECRET || process.env.JWT_SECRET + '_temp',
    { expiresIn: '5m' }
  );

  resetAttempts(req.ip);
  res.json({ tempToken, requires2fa: true, displayName });
});

// --- שלב 2: אימות קוד TOTP ---
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'tempToken ו-code נדרשים' });
  }

  let payload;
  try {
    payload = jwt.verify(
      tempToken,
      process.env.JWT_TEMP_SECRET || process.env.JWT_SECRET + '_temp'
    );
  } catch {
    return res.status(401).json({ error: 'tempToken לא תקף או פג תוקף' });
  }

  if (payload.step !== '2fa_required') {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(payload.username);

  const valid = speakeasy.totp.verify({
    secret:   user.totp_secret,
    encoding: 'base32',
    token:    code,
    window:   1, // ±30 שניות
  });

  if (!valid) {
    return res.status(401).json({ error: 'קוד 2FA שגוי' });
  }

  db.prepare('UPDATE user_accounts SET last_login = unixepoch() WHERE username = ?').run(payload.username);
  logAudit('info', 'auth', `התחברות עם 2FA: ${payload.username} (${payload.role})`, { username: payload.username, ip: req.ip });

  const token = jwt.sign(
    { username: payload.username, role: payload.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, role: payload.role });
});

// --- הגדרת 2FA: קבל QR code ---
router.post('/setup-2fa', requireSetupOrAuth, async (req, res) => {
  const db     = getDb();
  const secret = speakeasy.generateSecret({
    name:   `NetMonitor (${req.user.username})`,
    length: 20,
  });

  // שמור secret זמני (לא מאופשר עדיין עד confirm)
  db.prepare('UPDATE user_accounts SET totp_secret = ? WHERE username = ?')
    .run(secret.base32, req.user.username);

  // צור QR code
  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qrCode: qrDataUrl });
});

// --- אישור הגדרת 2FA (אחרי סריקת QR) ---
router.post('/confirm-2fa', requireSetupOrAuth, (req, res) => {
  const { code } = req.body;
  const db       = getDb();
  const user     = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(req.user.username);

  if (!user?.totp_secret) {
    return res.status(400).json({ error: 'קודם הגדר 2FA דרך setup-2fa' });
  }

  const valid = speakeasy.totp.verify({
    secret:   user.totp_secret,
    encoding: 'base32',
    token:    code,
    window:   1,
  });

  if (!valid) {
    return res.status(401).json({ error: 'קוד שגוי, נסה שוב' });
  }

  db.prepare('UPDATE user_accounts SET totp_enabled = 1, last_login = unixepoch() WHERE username = ?').run(req.user.username);
  logAudit('info', 'auth', `2FA הוגדר ואומת: ${req.user.username}`, { username: req.user.username, ip: req.ip });

  // הנפק JWT מלא — המשתמש מוכן להיכנס למערכת
  const token = jwt.sign(
    { username: req.user.username, role: req.user.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ ok: true, token, role: req.user.role, message: '2FA הופעל בהצלחה' });
});

// --- מידע על המשתמש הנוכחי ---
router.get('/me', requireAuth, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT username, role, totp_enabled, last_login FROM user_accounts WHERE username = ?')
    .get(req.user.username);
  res.json(user || req.user);
});

module.exports = router;
