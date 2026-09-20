// routes/map.js — תמונת מפה ומיקומי מכשירים
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { getDb }                    = require('../db/database');
const { requireAuth, requireAdmin }= require('../middleware/auth');

// שמור תמונה בזיכרון (מועבר ל-DB כ-BLOB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].includes(file.mimetype);
    cb(ok ? null : new Error('קובץ חייב להיות תמונה'), ok);
  }
});

// ה-mimetype מגיע מהלקוח, ולכן בודקים גם שהתוכן באמת מתאים לו: קובץ HTML שהוצג כ-image/png
// לא אמור להתקבל.
const LOOKS_LIKE = {
  'image/png':     b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg':    b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif':     b => b.length > 6 && b.subarray(0, 3).toString('ascii') === 'GIF',
  'image/svg+xml': b => /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8')),
};

// קבל תמונת המפה
router.get('/image', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT image_data, mime_type FROM floor_map WHERE id = 1').get();

  if (!row || !row.image_data) {
    return res.status(404).json({ error: 'לא הועלתה תמונה עדיין' });
  }

  res.set('Content-Type', row.mime_type);
  // SVG יכול להכיל סקריפט. גם אם מישהו יפתח את הכתובת ישירות, ה-sandbox וה-CSP מונעים הרצה.
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(row.image_data));
});

// העלה תמונת מפה חדשה
router.post('/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נשלחה תמונה' });
  if (!LOOKS_LIKE[req.file.mimetype](req.file.buffer)) {
    return res.status(400).json({ error: 'תוכן הקובץ אינו תואם לסוג התמונה שנבחר' });
  }

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO floor_map (id, image_data, mime_type, updated_at)
    VALUES (1, ?, ?, unixepoch())
  `).run(req.file.buffer, req.file.mimetype);

  res.json({ ok: true, size: req.file.size, mime: req.file.mimetype });
});

// מחק תמונת מפה
router.delete('/image', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM floor_map WHERE id = 1').run();
  res.json({ ok: true });
});

// קבל מיקומי מכשירים על המפה (רק מכשירים עם map_x וmap_y)
router.get('/positions', requireAuth, (req, res) => {
  const db      = getDb();
  const devices = db.prepare(`
    SELECT id, name, ip, status, sys_name, map_x, map_y
    FROM devices
    WHERE map_x IS NOT NULL AND map_y IS NOT NULL
  `).all();
  res.json(devices);
});

// שמור מיקום מכשיר על המפה
router.put('/positions/:deviceId', requireAdmin, (req, res) => {
  const db         = getDb();
  const { map_x, map_y } = req.body;

  if (map_x == null || map_y == null) {
    return res.status(400).json({ error: 'map_x ו-map_y נדרשים' });
  }
  if (!Number.isFinite(Number(map_x)) || !Number.isFinite(Number(map_y))) {
    return res.status(400).json({ error: 'map_x ו-map_y חייבים להיות מספרים' });
  }

  const result = db.prepare('UPDATE devices SET map_x = ?, map_y = ? WHERE id = ?')
    .run(Number(map_x), Number(map_y), req.params.deviceId);

  if (result.changes === 0) return res.status(404).json({ error: 'מכשיר לא נמצא' });
  res.json({ ok: true });
});

module.exports = router;
