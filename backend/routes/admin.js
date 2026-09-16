// routes/admin.js — הגדרות מערכת וניהול משתמשים (admin only)
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { getDb, getSetting, setSetting } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/secrets');
const { logAudit }     = require('../db/audit');

// קבל כל הגדרות המערכת (SMTP, LDAP, polling)
router.get('/settings', requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  const settings = {};
  for (const r of rows) {
    // אל תחשוף סיסמאות
    settings[r.key] = r.key.includes('password') || r.key.includes('pass')
      ? (r.value ? '***' : '')
      : r.value;
  }
  res.json(settings);
});

// עדכון הגדרות
router.put('/settings', requireAdmin, (req, res) => {
  const db      = getDb();
  const allowed = [
    'smtp_host','smtp_port','smtp_from','smtp_user','smtp_pass',
    'alert_recipients',
    'ldap_url','ldap_base_dn','ldap_bind_dn','ldap_bind_password',
    'ad_admin_group','ad_viewer_group',
    'default_poll_interval','retention_days',
    'alert_quiet_from','alert_quiet_to',
    'app_base_url',
    'update_feed_url'
  ];

  const SENSITIVE = new Set(['smtp_pass', 'ldap_bind_password']);

  const changed = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (!allowed.includes(key)) continue;
    // *** = לא שונה — המשתמש לא הקליד סיסמה חדשה
    if (SENSITIVE.has(key) && value === '***') { changed.push(key); continue; }
    setSetting(key, SENSITIVE.has(key) ? encrypt(value) : value);
    changed.push(key);
  }

  if (changed.length > 0) {
    logAudit('info', 'admin', 'settings_updated', { fields: changed.join(', ') }, { username: req.user?.username });
  }

  res.json({ ok: true });
});

// רשימת משתמשים
router.get('/users', requireAdmin, (req, res) => {
  const db    = getDb();
  const users = db.prepare(
    'SELECT id, username, role, totp_enabled, last_login, created_at FROM user_accounts'
  ).all();
  res.json(users);
});

// הוסף משתמש (demo mode — local accounts)
router.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role = 'viewer' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username ו-password נדרשים' });
  }

  const db   = getDb();
  const hash = await bcrypt.hash(password, 12);

  try {
    const result = db.prepare(`
      INSERT INTO user_accounts (username, password_hash, role)
      VALUES (?, ?, ?)
    `).run(username, hash, role);

    res.status(201).json({ id: result.lastInsertRowid, username, role });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `משתמש ${username} כבר קיים` });
    }
    throw err;
  }
});

// שנה role / password משתמש
router.put('/users/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const { role, password } = req.body;

  if (role) {
    db.prepare('UPDATE user_accounts SET role = ? WHERE id = ?').run(role, req.params.id);
  }
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE user_accounts SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }

  res.json({ ok: true });
});

// מחק משתמש
router.delete('/users/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM user_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// איפוס 2FA למשתמש
router.post('/users/:id/reset-2fa', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE user_accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true });
});

// בדיקת שרת דואר — מאמת חיבור, ואם התבקש גם שולח מייל ניסיון.
// שולח עם תקרות זמן קצרות: בדיקה ידנית לא אמורה להקפיא את הדפדפן.
router.post('/test-smtp', requireAdmin, async (req, res) => {
  const nodemailer = require('nodemailer');
  const { sendTest } = req.body || {};

  // ההגדרות שנשמרו, עם נפילה חזרה ל-env — בדיוק כמו שהמערכת עצמה עובדת
  const host = (getSetting('smtp_host') || process.env.SMTP_HOST || '').trim();
  const port = parseInt(getSetting('smtp_port') || process.env.SMTP_PORT || '25');
  const user = getSetting('smtp_user') || process.env.SMTP_USER || '';
  const pass = decrypt(getSetting('smtp_pass') || '') || process.env.SMTP_PASS || '';
  const from = getSetting('smtp_from') || process.env.SMTP_FROM || '';
  const to   = getSetting('alert_recipients') || process.env.ALERT_RECIPIENTS || '';

  if (!host) return res.status(400).json({ ok: false, stage: 'config', error: 'לא הוגדר שרת SMTP' });
  if (!from) return res.status(400).json({ ok: false, stage: 'config', error: 'לא הוגדרה כתובת שולח' });
  if (sendTest && !to) {
    return res.status(400).json({ ok: false, stage: 'config', error: 'לא הוגדרו נמענים' });
  }

  const t0 = Date.now();
  const transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 6000,
    greetingTimeout:   6000,
    socketTimeout:     8000,
  });

  try {
    // verify בודק חיבור, greeting ואימות — בלי לשלוח דבר
    await transporter.verify();
    const connectMs = Date.now() - t0;

    if (!sendTest) {
      logAudit('info', 'admin', 'smtp_test_ok', { host, port }, { username: req.user.username, ip: req.ip });
      return res.json({ ok: true, stage: 'connect', host, port, ms: connectMs,
                        message: `החיבור ל-${host}:${port} תקין (${connectMs}ms)` });
    }

    const info = await transporter.sendMail({
      from, to,
      subject: '[TK Comms Sentinel] מייל בדיקה',
      text: `זהו מייל בדיקה מ-TK Comms Sentinel.\n\n` +
            `שרת: ${host}:${port}\n` +
            `נשלח בידי: ${req.user.username}\n` +
            `זמן: ${new Date().toLocaleString('he-IL')}\n\n` +
            `אם קיבלת אותו — הגדרות הדואר תקינות.`,
    });

    logAudit('info', 'admin', 'test_email_sent', { to }, { username: req.user.username, ip: req.ip });
    res.json({ ok: true, stage: 'send', host, port, to, ms: Date.now() - t0,
               messageId: info.messageId,
               message: `מייל בדיקה נשלח אל ${to}` });
  } catch (err) {
    const ms = Date.now() - t0;
    // הודעות שאפשר לפעול לפיהן, במקום קוד שגיאה גולמי
    let hint = err.message;
    if (/ECONNREFUSED/.test(err.message))      hint = `השרת ${host} דחה את החיבור בפורט ${port}. בדוק שהפורט נכון ושהשירות פעיל.`;
    else if (/ETIMEDOUT|timeout/i.test(err.message)) hint = `אין תגובה מ-${host}:${port} תוך ${ms}ms. בדוק חומת אש או כתובת שגויה.`;
    else if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) hint = `לא ניתן לפתור את השם "${host}". השתמש בכתובת IP או בדוק DNS.`;
    else if (/EAUTH|535|534/.test(err.message))      hint = `שם המשתמש או הסיסמה נדחו על ידי השרת.`;
    else if (/self.signed|certificate/i.test(err.message)) hint = `בעיית תעודת TLS מול ${host}.`;

    logAudit('warn', 'admin', 'smtp_test_failed', { error: err.message }, { username: req.user.username, ip: req.ip });
    res.status(200).json({ ok: false, stage: 'connect', host, port, ms, error: hint, raw: err.message });
  } finally {
    try { transporter.close(); } catch {}
  }
});

// סטטיסטיקות כלליות לדאשבורד
router.get('/stats', requireAdmin, (req, res) => {
  const db = getDb();
  const totalDevices = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const upDevices    = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'up'").get().n;
  const downDevices  = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'down'").get().n;
  const openAlerts   = db.prepare("SELECT COUNT(*) AS n FROM alert_events WHERE resolved_at IS NULL").get().n;

  res.json({ totalDevices, upDevices, downDevices, openAlerts });
});

module.exports = router;
