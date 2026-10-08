// routes/layout.js — תצוגת Switch Layout (חזית הסוויץ', פורטים, חלק אחורי). לקריאה בלבד.
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const router  = express.Router();
const { getDb }                     = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit }                  = require('../db/audit');
const sl = require('../services/switchLayout');

const validId = (v) => /^\d{1,9}$/.test(String(v));
const MAX_IMAGE = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE, files: 1 } });

const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const kindOf = (b) => (b.length > 8 && b.subarray(0, 8).equals(PNG) ? 'png'
                    : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : null);

// GET /api/layout/device/:id — הפורטים של כל חבר, מוכנים לציור
router.get('/device/:id', requireAuth, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'invalid device id' });
  const device = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  res.json(sl.buildLayout(device));
});

// GET /api/layout/image/:key — תמונת החזית של משפחת דגמים (404 = אין תמונה, והתצוגה מציירת סרטוט נקי)
router.get('/image/:key', requireAuth, (req, res) => {
  const file = sl.imagePath(req.params.key);
  if (!file) return res.status(404).json({ error: 'no image' });
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(path.extname(file) === '.jpg' ? 'image/jpeg' : 'image/png');
  res.sendFile(file);
});

// POST /api/layout/image/:key — החלפת/הוספת תמונה (מנהל). חייבת להיות חזית של אותה משפחה: מיקומי הפורטים קבועים.
router.post('/image/:key', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'התמונה גדולה מדי (עד 4MB)' : 'העלאה נכשלה' });
    const key = req.params.key;
    if (!sl.LAYOUT_KEYS.includes(key)) return res.status(400).json({ error: 'תצוגה לא מוכרת' });
    if (!req.file) return res.status(400).json({ error: 'לא נשלחה תמונה' });
    const kind = kindOf(req.file.buffer);
    if (!kind) return res.status(400).json({ error: 'הקובץ חייב להיות PNG או JPG' });

    const dir = sl.imagesDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const ext of sl.IMAGE_EXT) { try { fs.unlinkSync(path.join(dir, key + ext)); } catch (_) {} }
      fs.writeFileSync(path.join(dir, `${key}.${kind}`), req.file.buffer);
    } catch (e) {
      return res.status(500).json({ error: 'שמירת התמונה נכשלה' });
    }
    logAudit('info', 'admin', 'switch_image_uploaded', { key, size: req.file.size }, { username: req.user.username, ip: req.ip });
    res.json({ ok: true });
  });
});

// DELETE /api/layout/image/:key — חזרה לסרטוט הנקי
router.delete('/image/:key', requireAdmin, (req, res) => {
  const file = sl.imagePath(req.params.key);
  if (!file) return res.status(404).json({ error: 'no image' });
  try { fs.unlinkSync(file); } catch (_) { return res.status(500).json({ error: 'מחיקה נכשלה' }); }
  logAudit('info', 'admin', 'switch_image_deleted', { key: req.params.key }, { username: req.user.username, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
