// server.js — נקודת כניסה ראשית של ה-backend
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

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

const app  = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? false  // IIS מגיש הכל מאותו domain
    : ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// תגובות API לעולם לא מקאששות בדפדפן — אחרת חיפוש/סטטוס מחזירים תוצאה
// ישנה (למשל endpoint-search שהחזיר את התוצאה הראשונה מה-cache גם אחרי תיקון).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    demoMode:  process.env.DEMO_MODE === 'true',
    uptime:    process.uptime()
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
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'קובץ גדול מדי (מקסימום 10MB)' });
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

  app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║       NetMonitor Backend — v1.0.0        ║
║  פורט: ${PORT.toString().padEnd(5)}  Demo: ${process.env.DEMO_MODE === 'true' ? 'ON ' : 'OFF'}              ║
╚═══════════════════════════════════════════╝
  `);
    console.log(`[Server] http://localhost:${PORT}/api/health`);
  });
})();

module.exports = app;
