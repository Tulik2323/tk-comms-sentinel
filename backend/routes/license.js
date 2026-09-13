'use strict';
// routes/license.js — /api/license/* endpoints
const express  = require('express');
const router   = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const license  = require('../lib/license');

// GET /api/license/status — any authenticated user
router.get('/status', requireAuth, (req, res) => {
  try {
    res.json(license.getLicenseStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/license/activate — admin only
router.post('/activate', requireAdmin, (req, res) => {
  const { key } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'נדרש שדה key' });
  }
  const result = license.activateLicense(key);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ ok: true, status: result.status });
});

module.exports = router;
