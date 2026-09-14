// routes/updates.js — בדיקת עדכונים והפעלת המעדכן (admin only)
//
// הצד של האפליקציה במנגנון העדכון-ONLINE. שני חלקים:
//   GET  /check   — קורא את פיד העדכונים (latest.json) ומשווה לגרסה המותקנת.
//                   קריאה בלבד, בטוח לגמרי בפרודקשן.
//   POST /install — מוריד את חבילת העדכון, מאמת sha256, מחלץ אותה, ואז מריץ
//                   את update.ps1 מנותק (detached). כל זה תפקיד ה-caller לפי
//                   החוזה — update.ps1 עצמו לא מוריד ולא בודק feed/checksum.
//                   אינרטי לגמרי כל עוד TKCS_INSTALL_ROOT לא מוגדר (כלומר
//                   בשרת בית החולים תחת IIS, ובפיתוח) — הכפתור לא עושה כלום.
//
// === החוזה עם פרויקט המתקין (C:\dev\tkcs-installer) — מיושר לקוד שכבר נבדק שם ===
//   • גרסה מותקנת = קובץ VERSION בשורש ההתקנה (<TKCS_INSTALL_ROOT>\VERSION),
//     נכתב ע"י activate-version.ps1. semver פשוט (למשל 1.0.0).
//   • latest.json = { version, date, notes, downloadUrl, sha256 }
//     (downloadUrl מצביע לחבילת -VersionOnly; זו קריאה תואמת גם לשמות
//      download_url/published_at אם יופיעו — סבילות.)
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

// ---- בדיקת עדכונים (קריאה בלבד) ----
router.get('/check', requireAdmin, async (req, res) => {
  const current = resolveCurrentVersion();
  const DEFAULT_FEED = 'https://tulik2323.github.io/tk-comms-sentinel/latest.json';
  const url = (getSetting('update_feed_url') || DEFAULT_FEED).trim();

  if (!url) {
    return res.json({ ok: false, reason: 'no_url', current,
      message: 'לא הוגדרה כתובת בדיקת עדכונים' });
  }

  // AbortController — אל תקפיא את הדפדפן אם השרת לא זמין (בית חולים בלי אינטרנט)
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!resp.ok) {
      return res.json({ ok: false, reason: 'http', current,
        message: `שרת העדכונים החזיר שגיאה (${resp.status})` });
    }
    const feed   = await resp.json();
    const latest = String(feed.version || '').trim();
    if (!latest) {
      return res.json({ ok: false, reason: 'bad_feed', current,
        message: 'פורמט הפיד אינו תקין (חסר שדה version)' });
    }
    const updateAvailable = cmpSemver(current, latest) < 0;
    return res.json({
      ok:              true,
      current,
      latest,
      updateAvailable,
      notes:       feed.notes || '',
      // שמות החוזה: downloadUrl/date. סבילות לשמות חלופיים אם יופיעו.
      downloadUrl: feed.downloadUrl || feed.download_url  || '',
      sha256:      feed.sha256      || '',
      publishedAt: feed.date        || feed.published_at  || '',
    });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'תם הזמן הקצוב לבדיקה — שרת העדכונים לא הגיב'
      : 'לא ניתן להגיע לשרת העדכונים (בדוק חיבור/כתובת)';
    return res.json({ ok: false, reason: 'unreachable', current, message: msg, raw: err.message });
  } finally {
    clearTimeout(timer);
  }
});

// ---- הפעלת המעדכן (חוזה עם פרויקט המתקין) ----
// ה-caller (כאן) מוריד+מאמת+מחלץ, ואז מריץ את update.ps1 detached.
router.post('/install', requireAdmin, async (req, res) => {
  const { version, downloadUrl, sha256 } = req.body || {};
  const script = updaterScriptPath();

  // בלי מבנה מתקין — אינרטי. זה המצב בשרת בית החולים (IIS) ובפיתוח.
  if (!script || !fs.existsSync(script)) {
    return res.json({ started: false, reason: 'no_updater',
      message: 'המעדכן אינו זמין בהתקנה זו. עדכון אוטומטי פעיל רק בהתקנות שנעשו דרך המתקין.' });
  }
  if (!downloadUrl) {
    return res.json({ started: false, reason: 'no_url',
      message: 'חסרה כתובת הורדה בפיד העדכונים.' });
  }

  const workDir    = path.join(process.env.TKCS_DATA_DIR || os.tmpdir(), 'tkcs-updates');
  const zipPath    = path.join(workDir, `update-${(version || 'new')}.zip`);
  const extractDir = path.join(workDir, `extract-${(version || Date.now())}`);

  try {
    fs.mkdirSync(workDir, { recursive: true });

    // 1. הורדה — דרך fetch של Node (OpenSSL), נתיב ה-TLS האמין בשרתים מוקשחים
    const resp = await fetch(downloadUrl);
    if (!resp.ok) {
      return res.json({ started: false, reason: 'download',
        message: `הורדת חבילת העדכון נכשלה (${resp.status})` });
    }
    const buf = Buffer.from(await resp.arrayBuffer());

    // 2. אימות שלמות — sha256 מול הערך שבפיד
    if (sha256) {
      const got = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
      if (got !== String(sha256).toLowerCase()) {
        return res.json({ started: false, reason: 'checksum',
          message: 'בדיקת שלמות הקובץ נכשלה (sha256 לא תואם) — העדכון בוטל.' });
      }
    }
    fs.writeFileSync(zipPath, buf);

    // 3. חילוץ — Expand-Archive (פעולת קובץ מקומית, בלי TLS)
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
         `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
        { windowsHide: true });
      p.on('exit',  c => c === 0 ? resolve() : reject(new Error(`חילוץ נכשל (קוד ${c})`)));
      p.on('error', reject);
    });

    // 4. תשובה ללקוח *לפני* הפעלת המעדכן — כי update.ps1 עוצר את השירות הזה
    logAudit('warn', 'admin', `הופעל עדכון מערכת לגרסה ${version}`,
      { username: req.user?.username, ip: req.ip });
    res.json({ started: true,
      message: `העדכון לגרסה ${version} החל. המערכת תופעל מחדש בקרוב.` });

    // 5. אחרי שהתשובה נשלחה — הפעל את update.ps1 מנותק (ישרוד את עצירת השירות)
    res.on('finish', () => {
      try {
        const child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
           '-File', script, '-SourcePackageDir', extractDir],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch (e) {
        logAudit('error', 'admin', `כשל בהפעלת update.ps1: ${e.message}`,
          { username: req.user?.username });
      }
    });
  } catch (err) {
    logAudit('error', 'admin', `כשל בעדכון: ${err.message}`,
      { username: req.user?.username, ip: req.ip });
    if (!res.headersSent) {
      return res.json({ started: false, reason: 'error',
        message: `שגיאה בעדכון: ${err.message}` });
    }
  }
});

module.exports = router;
