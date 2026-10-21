// routes/help.js — מדריך השימוש לדף /help
// הדף לא מכיל תוכן משלו: הוא מציג את backend/help/guide.md כמו שהוא.
// הקובץ נקרא בכל בקשה, כך שעדכון שלו לא דורש הפעלה מחדש.
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');

const GUIDE_PATH = path.join(__dirname, '..', 'help', 'guide.md');

// GET /api/help — כל משתמש מחובר
router.get('/', requireAuth, (req, res) => {
  fs.readFile(GUIDE_PATH, 'utf8', (err, markdown) => {
    // 200 עם ok:false — IIS מחליף גוף של 4xx/5xx בדף שגיאה משלו
    if (err) return res.json({ ok: false, error: 'guide_missing' });
    res.json({ ok: true, markdown });
  });
});

module.exports = router;
