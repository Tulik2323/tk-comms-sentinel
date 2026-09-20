'use strict';
// routes/license.js — /api/license/* endpoints
const express  = require('express');
const router   = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const license  = require('../lib/license');
const { logAudit } = require('../db/audit');

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
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.length > 4096) {
    return res.status(400).json({ error: 'נדרש שדה key' });
  }
  const result = license.activateLicense(key);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  // המפתח עצמו לא נרשם, רק למי הוא הונפק ועד מתי
  logAudit('warn', 'admin', 'license_activated',
    { customer: result.status.customer || '', expiry: result.status.expiry || '' },
    { username: req.user.username, ip: req.ip });
  res.json({ ok: true, status: result.status });
});

module.exports = router;
