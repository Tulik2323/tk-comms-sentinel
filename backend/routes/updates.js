// routes/updates.js — בדיקת עדכונים והפעלת המעדכן (admin only)
//
// הצד של האפליקציה במנגנון העדכון-ONLINE. שני חלקים:
//   GET  /check   — קורא את פיד העדכונים (latest.json) ומשווה לגרסה המותקנת.
//                   קריאה בלבד, בטוח לגמרי בפרודקשן.
//   POST /install — קורא שוב את הפיד *מהשרת*, מוודא שהוא חתום על ידי היצרן, מוריד את החבילה,
//                   מאמת sha256, מחלץ אותה, ואז מריץ את update.ps1 מנותק (detached).
//                   אינרטי לגמרי כל עוד TKCS_INSTALL_ROOT לא מוגדר (כלומר בשרת בית החולים
//                   תחת IIS, ובפיתוח) — הכפתור לא עושה כלום.
//
// === אבטחה ===
// עד 1.4.2 כתובת ההורדה וה-sha256 הגיעו מגוף הבקשה, כלומר כל מי שהחזיק טוקן admin יכול היה
// להריץ חבילה משלו על השרת. עכשיו גוף הבקשה לא קובע כלום: החבילה נלקחת מהפיד שהוגדר בשרת,
// וההתקנה מתבצעת רק אם הפיד חתום ב-Ed25519 (אותו מפתח יצרן של הרישוי, עם קידומת נפרדת:
// tkcs-update-v1) ומכיל sha256 שהחבילה חייבת לעמוד בו. הפיד חתום בסקריפט השחרור (deploy-local.ps1).
//
// === החוזה עם פרויקט המתקין (C:\dev\tkcs-installer) ===
//   • גרסה מותקנת = קובץ VERSION בשורש ההתקנה (<TKCS_INSTALL_ROOT>\VERSION),
//     נכתב ע"י activate-version.ps1. semver פשוט (למשל 1.0.0).
//   • latest.json = { version, date, notes, downloadUrl, sha256, signature }
//   • update.ps1 נמצא ב-<TKCS_INSTALL_ROOT>\installer\scripts\update.ps1,
//     מקבל -SourcePackageDir <תיקייה שכבר חולצה> (מכילה versions\<v>\...),
//     עושה copy+swap junction+health-check+rollback. חייב לרוץ detached כי
//     הוא עוצר את שירות ה-backend באמצע.
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const { getSetting } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { logAudit }     = require('../db/audit');
const license          = require('../lib/license');

const DEFAULT_FEED       = 'https://tulik2323.github.io/tk-comms-sentinel/latest.json';
const FEED_TIMEOUT_MS    = 8000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PACKAGE_BYTES  = 500 * 1024 * 1024;
const SHA256_HEX         = /^[0-9a-f]{64}$/;
const SEMVER             = /^\d+\.\d+\.\d+([.\-][a-zA-Z0-9]+)*$/;

// ---- מקור הגרסה המותקנת ----
// עדיפות: env → VERSION בשורש ההתקנה (מבנה מתקין) → VERSION בשורש (IIS) →
//         package.json → 'dev'.
function resolveCurrentVersion() {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }
  const candidates = [];
  if (process.env.TKCS_INSTALL_ROOT) {
    candidates.push(path.join(process.env.TKCS_INSTALL_ROOT, 'VERSION'));   // מבנה מתקין
  }
  candidates.push(path.join(__dirname, '..', '..', 'VERSION'));             // <root>/VERSION (IIS)
  for (const vf of candidates) {
    try {
      if (fs.existsSync(vf)) {
        const v = fs.readFileSync(vf, 'utf8').trim();
        if (v) return v;
      }
    } catch (_) {}
  }
  try {
    const pkg = require('../package.json');
    if (pkg.version) return pkg.version;
  } catch (_) {}
  return 'dev';
}

// ---- השוואת semver פשוטה (major.minor.patch) ----
function cmpSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// נתיב update.ps1 לפי החוזה — או '' אם אין מבנה מתקין (=אינרטי)
function updaterScriptPath() {
  const root = (process.env.TKCS_INSTALL_ROOT || '').trim();
  if (!root) return '';
  return path.join(root, 'installer', 'scripts', 'update.ps1');
}

// ההודעה שהיצרן חותם עליה. שדות הפיד שמשפיעים על מה שיורץ (גרסה, checksum, כתובת) כולם בפנים,
// כך שאי אפשר להחליף אחד מהם בלי לשבור את החתימה. הקידומת מונעת שימוש חוזר בחתימת רישוי.
function updateMessage({ version, sha256, downloadUrl }) {
  return `tkcs-update-v1\n${version}\n${String(sha256).toLowerCase()}\n${downloadUrl}`;
}

// ---- קריאת הפיד מהשרת: מנורמל, עם בדיקת חתימה ----
async function readFeed() {
  const url = (getSetting('update_feed_url') || DEFAULT_FEED).trim();
  if (!url) return { ok: false, reason: 'no_url', message: 'לא הוגדרה כתובת בדיקת עדכונים' };

  let parsed;
  try { parsed = new URL(url); } catch {
    return { ok: false, reason: 'bad_url', message: 'כתובת פיד העדכונים אינה תקינה' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'insecure_feed', message: 'כתובת פיד העדכונים חייבת להיות HTTPS' };
  }

  // AbortController — אל תקפיא את הדפדפן אם השרת לא זמין (בית חולים בלי אינטרנט)
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-cache' } });
    if (!resp.ok) {
      return { ok: false, reason: 'http', message: `שרת העדכונים החזיר שגיאה (${resp.status})` };
    }
    if (resp.url && !resp.url.startsWith('https:')) {
      return { ok: false, reason: 'insecure_feed', message: 'הפיד הופנה לכתובת שאינה HTTPS' };
    }
    const raw = await resp.json();
    const feed = {
      version:     String((raw && raw.version) || '').trim(),
      downloadUrl: String((raw && (raw.downloadUrl || raw.download_url)) || '').trim().slice(0, 2048),
      sha256:      String((raw && raw.sha256) || '').trim().toLowerCase(),
      signature:   String((raw && raw.signature) || '').trim().slice(0, 512),
      notes:       String((raw && raw.notes) || '').slice(0, 2000),
      publishedAt: String((raw && (raw.date || raw.published_at)) || '').slice(0, 64),
    };
    if (!SEMVER.test(feed.version)) {
      return { ok: false, reason: 'bad_feed', message: 'פורמט הפיד אינו תקין (חסר שדה version)' };
    }
    const verified = SHA256_HEX.test(feed.sha256) && Boolean(feed.downloadUrl) && Boolean(feed.signature) &&
                     license.verifyDetached(updateMessage(feed), feed.signature);
    return { ok: true, feed, verified };
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'תם הזמן הקצוב לבדיקה — שרת העדכונים לא הגיב'
      : 'לא ניתן להגיע לשרת העדכונים (בדוק חיבור/כתובת)';
    return { ok: false, reason: 'unreachable', message: msg, raw: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// הורדה עם תקרת גודל וזמן — חבילה ענקית או שרת שמחזיק את החיבור לא יכולים לתקוע את התהליך
async function downloadCapped(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return { ok: false, reason: 'download', message: `הורדת חבילת העדכון נכשלה (${resp.status})` };
    if (resp.url && !resp.url.startsWith('https:')) {
      return { ok: false, reason: 'insecure_download', message: 'ההורדה הופנתה לכתובת שאינה HTTPS' };
    }
    const declared = Number(resp.headers.get('content-length'));
    if (declared > MAX_PACKAGE_BYTES) {
      return { ok: false, reason: 'too_large', message: 'חבילת העדכון גדולה מהמותר' };
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > MAX_PACKAGE_BYTES) {
        ctrl.abort();
        return { ok: false, reason: 'too_large', message: 'חבילת העדכון גדולה מהמותר' };
      }
      chunks.push(chunk);
    }
    return { ok: true, buf: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- בדיקת עדכונים (קריאה בלבד) ----
router.get('/check', requireAdmin, async (req, res) => {
  const current = resolveCurrentVersion();
  const got = await readFeed();
  if (!got.ok) {
    return res.json({ ok: false, reason: got.reason, current, message: got.message, raw: got.raw });
  }
  const { feed, verified } = got;
  return res.json({
    ok:              true,
    current,
    latest:          feed.version,
    updateAvailable: cmpSemver(current, feed.version) < 0,
    notes:           feed.notes,
    downloadUrl:     feed.downloadUrl,
    sha256:          feed.sha256,
    publishedAt:     feed.publishedAt,
    verified,   // false = הפיד לא חתום כראוי; התקנה אוטומטית תיחסם
    warning:     verified ? '' : 'פיד העדכונים אינו חתום על ידי היצרן, ולכן התקנה אוטומטית חסומה',
  });
});

// ---- הפעלת המעדכן (חוזה עם פרויקט המתקין) ----
let installing = false;

router.post('/install', requireAdmin, async (req, res) => {
  const script = updaterScriptPath();

  // בלי מבנה מתקין — אינרטי. זה המצב בשרת בית החולים (IIS) ובפיתוח.
  if (!script || !fs.existsSync(script)) {
    return res.json({ started: false, reason: 'no_updater',
      message: 'המעדכן אינו זמין בהתקנה זו. עדכון אוטומטי פעיל רק בהתקנות שנעשו דרך המתקין.' });
  }
  if (installing) {
    return res.status(409).json({ started: false, reason: 'busy', message: 'עדכון כבר מתבצע' });
  }

  const refuse = (reason, message, extra = {}) => {
    logAudit('warn', 'admin', 'update_refused', { reason }, { username: req.user?.username, ip: req.ip });
    return res.json({ started: false, reason, message, ...extra });
  };

  installing = true;
  try {
    // מה להתקין נקבע כאן, מהפיד שהוגדר בשרת. גוף הבקשה (כתובת, checksum) לא נלקח בחשבון.
    const current = resolveCurrentVersion();
    const got = await readFeed();
    if (!got.ok) return res.json({ started: false, reason: got.reason, message: got.message });

    const { feed, verified } = got;
    if (!verified) {
      return refuse('unsigned',
        'פיד העדכונים אינו חתום כראוי על ידי היצרן (חתימה או sha256 חסרים או שגויים) — העדכון בוטל.');
    }
    if (cmpSemver(current, feed.version) >= 0) {
      return refuse('not_newer', 'המערכת כבר מעודכנת לגרסה זו או חדשה ממנה.');
    }
    const requested = req.body && req.body.version;
    if (requested && String(requested) !== feed.version) {
      return refuse('version_mismatch', 'הפיד התעדכן מאז הבדיקה האחרונה. בדוק עדכונים שוב.');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(feed.downloadUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('not https');
    } catch {
      return refuse('invalid_url', 'כתובת ההורדה בפיד אינה תקינה (נדרש HTTPS).');
    }

    // גרסה מאומתת ל-semver בלבד, כדי שלא תוכל לשמש בנתיב הקבצים או בפקודה
    const safeVersion = SEMVER.test(feed.version) ? feed.version : 'new';
    const workDir     = path.join(process.env.TKCS_DATA_DIR || os.tmpdir(), 'tkcs-updates');
    const zipPath     = path.join(workDir, `update-${safeVersion}.zip`);
    const extractDir  = path.join(workDir, `extract-${safeVersion}`);

    fs.mkdirSync(workDir, { recursive: true });

    // 1. הורדה — דרך fetch של Node (OpenSSL), נתיב ה-TLS האמין בשרתים מוקשחים
    const dl = await downloadCapped(parsedUrl.toString());
    if (!dl.ok) return refuse(dl.reason, dl.message);

    // 2. אימות שלמות — חובה. ה-sha256 חתום יחד עם הפיד, ולכן חבילה אחרת נדחית.
    const got256 = crypto.createHash('sha256').update(dl.buf).digest('hex');
    if (got256 !== feed.sha256) {
      return refuse('checksum', 'בדיקת שלמות הקובץ נכשלה (sha256 לא תואם) — העדכון בוטל.');
    }
    fs.writeFileSync(zipPath, dl.buf);

    // 3. חילוץ — Expand-Archive (פעולת קובץ מקומית, בלי TLS)
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
         `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${extractDir}" -Force`],
        { windowsHide: true });
      p.on('exit',  c => c === 0 ? resolve() : reject(new Error(`חילוץ נכשל (קוד ${c})`)));
      p.on('error', reject);
    });

    // 4. תשובה ללקוח *לפני* הפעלת המעדכן — כי update.ps1 עוצר את השירות הזה
    logAudit('warn', 'admin', 'update_triggered', { version: safeVersion },
      { username: req.user?.username, ip: req.ip });
    res.json({ started: true,
      message: `העדכון לגרסה ${safeVersion} החל. המערכת תופעל מחדש בקרוב.` });

    // 5. אחרי שהתשובה נשלחה — הפעל את update.ps1 מנותק (ישרוד את עצירת השירות)
    res.on('finish', () => {
      try {
        const child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
           '-File', script, '-SourcePackageDir', extractDir],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch (e) {
        logAudit('error', 'admin', 'update_ps1_failed', { error: e.message },
          { username: req.user?.username, ip: req.ip });
      }
    });
  } catch (err) {
    logAudit('error', 'admin', 'update_failed', { error: err.message },
      { username: req.user?.username, ip: req.ip });
    if (!res.headersSent) {
      return res.json({ started: false, reason: 'error',
        message: `שגיאה בעדכון: ${err.message}` });
    }
  } finally {
    installing = false;
  }
});

module.exports = router;
module.exports.__test = { updateMessage, readFeed, cmpSemver };
