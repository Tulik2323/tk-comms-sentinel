// routes/auth.js — login, 2FA, logout
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const speakeasy= require('speakeasy');
const qrcode   = require('qrcode');

const { getDb }                = require('../db/database');
const { authenticateAD }       = require('../services/ldap');
const {
  loginRateLimit, recordLoginFailure, recordLoginSuccess,
  twofaBlockedSec, recordTwofaFailure, recordTwofaSuccess, consumeCode,
  blockedMessage, clientIp,
} = require('../middleware/rateLimit');
const { requireAuth, requireSetupOrAuth } = require('../middleware/auth');
const { signMain, signTemp, verifyTemp }  = require('../services/tokens');
const { burnCompare }          = require('../services/passwords');
const { logAudit }             = require('../db/audit');

const DEMO_MODE = process.env.DEMO_MODE === 'true';

// שם משתמש שנכנס ללוג ולהודעות: בלי תווי בקרה (שורה חדשה בלוג מזייפת שורות) ובאורך סביר
const safeName = (u) => String(u == null ? '' : u).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 64);

// כשל התחברות: נרשם ב-Audit עם הכתובת, נספר לחסימה, ואם הניסיון הזה גרם לחסימה נרשמת גם היא
function loginFailure(req, username, reason) {
  const name = safeName(username);
  logAudit('warn', 'auth', 'login_failed', { username: name, error: reason }, { username: name, ip: clientIp(req) });
  if (recordLoginFailure(req, username)) {
    logAudit('warn', 'auth', 'login_locked', { username: name }, { username: name, ip: clientIp(req) });
  }
}

// --- שלב 1: Login ---
// מאמת username+password (LDAP או local), מחזיר tempToken שדורש 2FA
router.post('/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });
  }
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
    return res.status(400).json({ error: 'שם משתמש או סיסמה שגויים' });
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
        await burnCompare(password);   // אותו זמן תגובה כמו סיסמה שגויה — שם משתמש לא נחשף
        loginFailure(req, username, 'unknown user');
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
      }
      const valid = await bcrypt.compare(password, localUser.password_hash);
      if (!valid) {
        loginFailure(req, username, 'wrong password');
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
    console.warn(`[Auth] כשל login ל-${safeName(username)}: ${err.message}`);
    // כשל תשתית (AD למטה, חשבון השירות נדחה) הוא לא ניסיון ניחוש, ולכן לא נספר לחסימה
    if (err.kind === 'config' || err.kind === 'unavailable') {
      logAudit('warn', 'auth', 'login_failed', { username: safeName(username), error: err.message }, { username: safeName(username), ip: clientIp(req) });
    } else {
      // 'unconfigured' (אין LDAP בכלל): מבחוץ זו כניסה כושלת רגילה. אותו זמן תגובה כמו סיסמה שגויה, נספרת לחסימה,
      // והסיבה האמיתית נרשמת ב-Audit למנהל.
      if (err.kind === 'unconfigured') await burnCompare(password);
      loginFailure(req, username, err.message);
    }

    // סיסמה שגויה ותקלת תשתית הן לא אותו דבר. החזרת 401 גנרי על הכל
    // שלחה משתמשים לאפס את הסיסמה כשהבעיה הייתה חברות בקבוצה או DC למטה.
    // פרטי השגיאה (שם שרת, DN, הודעת LDAP) נרשמים ב-Audit ולא חוזרים למי שלא מחובר.
    switch (err.kind) {
      case 'forbidden':
        return res.status(403).json({ error: err.message });
      case 'config':
      case 'unavailable':
        return res.status(503).json({
          error: 'שירות האימות אינו זמין כרגע. פנה למנהל המערכת.',
        });
      default:
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }
  }

  // הסיסמה אומתה: מאפסים רק את מונה שם המשתמש, לא את מונה הכתובת
  recordLoginSuccess(username);

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
  // הטוקן הזה חתום בסוד הביניים ומותר רק ל-setup-2fa / confirm-2fa.
  // requireAuth דוחה אותו מיד, כך שאין גישה לשום endpoint אחר.
  if (!userRecord.totp_enabled) {
    const setupToken = signTemp({ username, role, setupOnly: true }, '15m');
    logAudit('info', 'auth', 'login_2fa_required', { username, role }, { username, ip: clientIp(req) });
    return res.json({ setupToken, setupRequired: true, role, displayName });
  }

  // יש TOTP — תן tempToken שדורש verify
  const tempToken = signTemp({ username, role, step: '2fa_required' }, '5m');
  res.json({ tempToken, requires2fa: true, displayName });
});

// --- שלב 2: אימות קוד TOTP ---
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code || typeof tempToken !== 'string') {
    return res.status(400).json({ error: 'tempToken ו-code נדרשים' });
  }

  let payload;
  try {
    payload = verifyTemp(tempToken);
  } catch {
    return res.status(401).json({ error: 'tempToken לא תקף או פג תוקף' });
  }

  if (payload.step !== '2fa_required') {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }

  const ip = clientIp(req);
  const blockedSec = twofaBlockedSec(req, payload.username);
  if (blockedSec > 0) {
    res.set('Retry-After', String(blockedSec));
    return res.status(429).json({ error: blockedMessage(blockedSec) });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(payload.username);
  if (!user || !user.totp_secret) {
    return res.status(401).json({ error: 'tempToken לא תקף או פג תוקף' });
  }

  const token = String(code).trim();
  const valid = /^\d{6}$/.test(token) && speakeasy.totp.verify({
    secret:   user.totp_secret,
    encoding: 'base32',
    token,
    window:   1, // ±30 שניות
  });

  if (!valid) {
    logAudit('warn', 'auth', 'login_2fa_failed', { username: safeName(payload.username) }, { username: safeName(payload.username), ip });
    if (recordTwofaFailure(req, payload.username)) {
      logAudit('warn', 'auth', 'login_locked', { username: safeName(payload.username) }, { username: safeName(payload.username), ip });
    }
    return res.status(401).json({ error: 'קוד 2FA שגוי' });
  }

  // קוד שכבר שימש לא מתקבל שוב, גם אם הוא עדיין בתוך חלון הזמן
  if (!consumeCode(payload.username, token)) {
    logAudit('warn', 'auth', 'login_2fa_failed', { username: safeName(payload.username) }, { username: safeName(payload.username), ip });
    recordTwofaFailure(req, payload.username);
    return res.status(401).json({ error: 'הקוד כבר שימש. המתן לקוד הבא' });
  }

  recordTwofaSuccess(payload.username);
  db.prepare('UPDATE user_accounts SET last_login = unixepoch() WHERE username = ?').run(payload.username);
  logAudit('info', 'auth', 'login_2fa_success', { username: payload.username, role: user.role }, { username: payload.username, ip });

  // התפקיד נלקח מה-DB (נקבע בשלב הסיסמה) ולא מטוקן הביניים
  const jwtToken = signMain({ username: payload.username, role: user.role }, '8h');
  res.json({ token: jwtToken, role: user.role });
});

// --- הגדרת 2FA: קבל QR code ---
// משתמש שכבר הפעיל 2FA חייב להציג את הקוד הנוכחי כדי להחליף אותו: טוקן שנגנב לא מספיק כדי להחליף
// לו את גורם ה-2FA. הסוד החדש נשמר כ"ממתין" ולא דורס את הפעיל עד שהקוד שלו אושר.
router.post('/setup-2fa', requireSetupOrAuth, async (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(req.user.username);
  if (!user) return res.status(401).json({ error: 'המשתמש אינו קיים במערכת, התחבר שוב' });

  if (user.totp_enabled) {
    const blockedSec = twofaBlockedSec(req, user.username);
    if (blockedSec > 0) {
      res.set('Retry-After', String(blockedSec));
      return res.status(429).json({ error: blockedMessage(blockedSec) });
    }
    const current = String((req.body && req.body.code) || '').trim();
    const ok = /^\d{6}$/.test(current) && speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: current, window: 1 });
    if (!ok) {
      logAudit('warn', 'auth', 'login_2fa_failed', { username: safeName(user.username) }, { username: safeName(user.username), ip: clientIp(req) });
      recordTwofaFailure(req, user.username);
      return res.status(403).json({ error: '2FA כבר מוגדר. כדי להחליף אותו יש להזין את הקוד הנוכחי', reauth: true });
    }
    recordTwofaSuccess(user.username);
  }

  const secret = speakeasy.generateSecret({
    name:   `NetMonitor (${req.user.username})`,
    length: 20,
  });

  db.prepare('UPDATE user_accounts SET totp_pending_secret = ? WHERE username = ?')
    .run(secret.base32, req.user.username);

  // צור QR code
  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qrCode: qrDataUrl });
});

// --- אישור הגדרת 2FA (אחרי סריקת QR) ---
router.post('/confirm-2fa', requireSetupOrAuth, (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  const db   = getDb();
  const user = db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(req.user.username);

  // סוד שממתין לאישור; חשבון שהתחיל הגדרה לפני 1.4.4 שמר אותו ב-totp_secret
  const candidate = user?.totp_pending_secret || (user && !user.totp_enabled ? user.totp_secret : null);
  if (!candidate) {
    return res.status(400).json({ error: 'קודם הגדר 2FA דרך setup-2fa' });
  }

  const blockedSec = twofaBlockedSec(req, user.username);
  if (blockedSec > 0) {
    res.set('Retry-After', String(blockedSec));
    return res.status(429).json({ error: blockedMessage(blockedSec) });
  }

  const valid = /^\d{6}$/.test(code) && speakeasy.totp.verify({
    secret:   candidate,
    encoding: 'base32',
    token:    code,
    window:   1,
  });

  if (!valid) {
    logAudit('warn', 'auth', 'login_2fa_failed', { username: safeName(user.username) }, { username: safeName(user.username), ip: clientIp(req) });
    recordTwofaFailure(req, user.username);
    return res.status(401).json({ error: 'קוד שגוי, נסה שוב' });
  }
  recordTwofaSuccess(user.username);

  // הסוד החדש הופך לפעיל, וכל טוקן ישן (כולל טוקן הגדרה) מתבטל
  db.prepare(`
    UPDATE user_accounts
    SET totp_secret = ?, totp_pending_secret = NULL, totp_enabled = 1,
        last_login = unixepoch(), token_valid_after = unixepoch()
    WHERE username = ?
  `).run(candidate, req.user.username);
  consumeCode(user.username, code);
  logAudit('info', 'auth', 'twofa_setup_done', { username: req.user.username }, { username: req.user.username, ip: clientIp(req) });

  // הנפק JWT מלא — המשתמש מוכן להיכנס למערכת
  const token = signMain({ username: req.user.username, role: req.user.role }, '8h');
  res.json({ ok: true, token, role: req.user.role, message: '2FA הופעל בהצלחה' });
});

// --- יציאה: מבטלת בצד השרת את הטוקן הזה בלבד (התחברות אחרת של אותו משתמש, למשל מסך בחדר בקרה, ממשיכה) ---
router.post('/logout', requireAuth, (req, res) => {
  const db = getDb();
  if (req.user.jti) {
    db.prepare('DELETE FROM revoked_tokens WHERE expires_at < unixepoch()').run();
    db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(req.user.jti, req.user.exp || 0);
  } else {
    // טוקן מלפני 1.4.4 בלי jti: אי אפשר לבטל אותו לבדו, אז מבטלים את כל ההתחברויות שהונפקו עד עכשיו
    db.prepare('UPDATE user_accounts SET token_valid_after = unixepoch() WHERE username = ?').run(req.user.username);
  }
  logAudit('info', 'auth', 'logout', { username: req.user.username }, { username: req.user.username, ip: clientIp(req) });
  res.json({ ok: true });
});

// --- מידע על המשתמש הנוכחי ---
router.get('/me', requireAuth, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT username, role, totp_enabled, last_login FROM user_accounts WHERE username = ?')
    .get(req.user.username);
  res.json(user || req.user);
});

module.exports = router;
