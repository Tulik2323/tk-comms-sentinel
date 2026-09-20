// server.js — נקודת כניסה ראשית של ה-backend
// טען .env ממיקום קבוע, לא לפי cwd — תחת שירות (NSSM) ה-cwd אינו backend,
// והטעינה התלוית-cwd נכשלה בשקט (TLS/DB לא נטענו). כמו ב-poller-service.js.
//
// במבנה המגורס (versions\x.y.z\backend מוצמד דרך current junction), ה-.env
// יושב ב-data\ המשותפת, לא בתוך backend\ הגרסתי — כדי שעדכון גרסה לא ידרוס
// אותו. הנתיב מגיע דרך TKCS_DATA_DIR שה-service מזריק (svc-install.ps1).
// בלי המשתנה (למשל הרצה ידנית, או פריסה שטוחה ישנה) — נופל ל-__dirname,
// כלומר .env בתוך backend\ עצמו.
const path = require('path');
const dataDirForEnv = process.env.TKCS_DATA_DIR || __dirname;
require('dotenv').config({ path: path.join(dataDirForEnv, '.env') });

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');

require('./lib/async-errors');   // שגיאה ב-route אסינכרוני לא מפילה את התהליך

// בלי סוד JWT אי אפשר להנפיק או לאמת טוקן, והשרת לא יכול לעבוד. עדיף להיעצר בהודעה ברורה.
if (!process.env.JWT_SECRET) {
  console.error('[Server] JWT_SECRET לא מוגדר ב-.env — השרת לא יעלה בלעדיו.');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.warn('[Server] אזהרה: JWT_SECRET קצר מ-32 תווים. מומלץ סוד אקראי באורך 64 תווים.');
}

process.on('unhandledRejection', (reason) => {
  console.error('[Server] unhandledRejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException:', err && err.stack || err);
  setTimeout(() => process.exit(1), 100);   // IIS/iisnode מרים תהליך חדש בבקשה הבאה
});

const { initDb }       = require('./db/database');

const authRouter     = require('./routes/auth');
const devicesRouter  = require('./routes/devices');
const portsRouter    = require('./routes/ports');
const metricsRouter  = require('./routes/metrics');
const topologyRouter = require('./routes/topology');
const alertsRouter   = require('./routes/alerts');
const adminRouter    = require('./routes/admin');
const mapRouter      = require('./routes/map');
const auditRouter    = require('./routes/audit');
const toolsRouter     = require('./routes/tools');
const dashboardRouter = require('./routes/dashboard');
const reportsRouter   = require('./routes/reports');
const searchRouter       = require('./routes/search');
const portChangesRouter  = require('./routes/portChanges');
const trendsRouter       = require('./routes/trends');
const updatesRouter      = require('./routes/updates');
const licenseRouter      = require('./routes/license');
const inventoryRouter    = require('./routes/inventory');

const app  = express();
const PORT = process.env.PORT || 3001;

app.disable('x-powered-by');   // לא מפרסמים באיזו מסגרת השרת בנוי

// כתובת הלקוח האמיתית. מאחורי IIS (iisnode) השרת רואה רק את IIS, ובלי זה כל הלקוחות נראים כאחד:
// מגבלת הניסיונות משותפת לכולם ולוג הביקורת לא יודע מי ניסה להתחבר. iisnode מעביר את הכתובת ב-
// X-Forwarded-For (enableXFF ב-web.config) וקובע את IISNODE_VERSION. בהתקנה עצמאית (בלי IIS)
// אין proxy, ולכן לא סומכים על הכותרת: לקוח יכול לשלוח אותה בעצמו ולזייף כתובת.
// אפשר לקבוע ידנית מספר proxies אמינים ב-TRUST_PROXY_HOPS.
const trustHops = process.env.TRUST_PROXY_HOPS !== undefined
  ? parseInt(process.env.TRUST_PROXY_HOPS, 10)
  : (process.env.IISNODE_VERSION ? 1 : 0);
if (Number.isInteger(trustHops) && trustHops > 0) app.set('trust proxy', trustHops);

// --- כותרות אבטחה ---
// ה-frontend נבנה בלי סקריפטים inline ובלי משאבים חיצוניים, ולכן default-src 'self' מספיק.
// style-src צריך 'unsafe-inline' כי React וגרפים כותבים style בתוך האלמנטים.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Strict-Transport-Security':  'max-age=15552000',   // דפדפן מתעלם ממנה ב-HTTP רגיל
    'X-Content-Type-Options':     'nosniff',
    'X-Frame-Options':            'SAMEORIGIN',
    'Referrer-Policy':            'no-referrer',
    'Permissions-Policy':         'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy':    CSP,
  });
  next();
});

// --- Middleware ---
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? false  // IIS מגיש הכל מאותו domain
    : ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
// ייבוא CSV הוא היחיד שצריך גוף גדול; שאר הנתיבים מוגבלים ל-1MB
app.use('/api/devices/import-csv', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// תגובות API לעולם לא מקאששות בדפדפן — אחרת חיפוש/סטטוס מחזירים תוצאה
// ישנה (למשל endpoint-search שהחזיר את התוצאה הראשונה מה-cache גם אחרי תיקון).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// License guard — block all API calls (except auth / license / health) when
// the license is expired or the 7-day trial has ended.
// Unauthenticated requests (no Authorization header) pass through so that the
// auth middleware can return 401 as usual.
const licenseLib = require('./lib/license');
const LICENSE_BLOCK = new Set(['expired', 'trial-expired', 'invalid']);
const LICENSE_SKIP  = new Set(['/auth', '/license', '/health']);

app.use('/api', (req, res, next) => {
  const seg = '/' + req.path.split('/')[1];
  if (LICENSE_SKIP.has(seg)) return next();
  if (!req.headers.authorization) return next();
  const { status } = licenseLib.getLicenseStatus();
  if (LICENSE_BLOCK.has(status)) {
    return res.status(402).json({ error: 'license_required', status });
  }
  next();
});

// --- API Routes ---
app.use('/api/auth',     authRouter);
app.use('/api/devices',  devicesRouter);
app.use('/api/devices/:id/ports',   portsRouter);
app.use('/api/devices/:id/metrics', metricsRouter);
app.use('/api/topology', topologyRouter);
app.use('/api/alerts',   alertsRouter);
app.use('/api/admin',    adminRouter);
app.use('/api/map',      mapRouter);
app.use('/api/audit',   auditRouter);
app.use('/api/tools',      toolsRouter);
app.use('/api/dashboard',  dashboardRouter);
app.use('/api/reports',    reportsRouter);
app.use('/api/search',        searchRouter);
app.use('/api/port-changes',  portChangesRouter);
app.use('/api/trends',        trendsRouter);
app.use('/api/updates',      updatesRouter);
app.use('/api/license',      licenseRouter);
app.use('/api/inventory',    inventoryRouter);

// Health check
// version נקרא מ-package.json, לא קשיח — אחרת אי אפשר להבחין בין גרסאות
// אחרי עדכון (update.ps1 בודק את ה-endpoint הזה בדיוק כדי לאמת עדכון).
const { version: APP_VERSION } = require('./package.json');
app.get('/api/health', (req, res) => {
  // פתוח בלי התחברות (update.ps1 ובדיקות זמינות תלויים בו), ולכן רק מה שהם צריכים
  res.json({
    status:    'ok',
    version:   APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// --- Static Files (Production: React build) ---
// בפיתוח: ../frontend/dist | בייצור (iisnode): ./frontend/dist
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
// קבצי ה-assets עם hash בשם — בטוח לקאשש לזמן ארוך. index.html — לעולם לא,
// אחרת הדפדפן ממשיך לטעון bundle ישן (עם הפניה ל-JS ישן) גם אחרי deploy.
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  },
}));
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) res.status(200).json({ api: 'NetMonitor API', docs: '/api/health' });
  });
});

// --- Error Handler ---
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'הבקשה או הקובץ גדולים מדי' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'גוף הבקשה אינו JSON תקין' });
  }
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
});

// --- הפעל מסד נתונים (async) ---
// ה-polling רץ בתהליך נפרד — poller-service.js. אל תפעיל אותו כאן:
// iisnode ממחזר workers, ולולאת polling בתוכם נקטעת באמצע.
(async () => {
  await initDb();

  // הפעל מתזמן דוחות
  try { require('./services/report-scheduler').reload(); } catch (e) {
    console.warn('[Reports] לא ניתן לטעון מתזמן:', e.message);
  }

  // --- Listener: HTTPS direct (standalone) or HTTP (dev / behind iisnode) ---
  // The standalone build terminates TLS itself (no IIS in front). Two ways to
  // supply a certificate, checked in order:
  //   1. PFX  — TLS_PFX_PATH (+ TLS_PFX_PASSWORD). The installer generates a
  //      self-signed .pfx via Windows' New-SelfSignedCertificate.
  //   2. PEM  — TLS_CERT_PATH + TLS_KEY_PATH, for a customer-supplied cert.
  // With no cert configured, fall back to plain HTTP on PORT (development).
  const httpsPort = parseInt(process.env.HTTPS_PORT || '9443', 10);

  const banner = (proto, port) => {
    const demo = process.env.DEMO_MODE === 'true' ? 'ON' : 'OFF';
    console.log(`
╔═══════════════════════════════════════════╗
║           TK Comms Sentinel — Backend      ║
╚═══════════════════════════════════════════╝`);
    console.log(`[Server] v${APP_VERSION}  ${proto}://localhost:${port}/api/health  (Demo: ${demo})`);
  };

  const pfxPath  = process.env.TLS_PFX_PATH;
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath  = process.env.TLS_KEY_PATH;

  let tlsOptions = null;
  try {
    if (pfxPath && fs.existsSync(pfxPath)) {
      tlsOptions = { pfx: fs.readFileSync(pfxPath), passphrase: process.env.TLS_PFX_PASSWORD || '' };
    } else if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      tlsOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    }
  } catch (e) {
    console.error(`[Server] cannot read TLS certificate: ${e.message}`);
    process.exit(1);
  }

  if (tlsOptions) {
    https.createServer(tlsOptions, app).listen(httpsPort, () => banner('https', httpsPort));
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Server] WARNING: no TLS certificate configured (TLS_PFX_PATH or TLS_CERT_PATH/TLS_KEY_PATH) — starting HTTP only.');
    }
    http.createServer(app).listen(PORT, () => banner('http', PORT));
  }
})();

module.exports = app;
