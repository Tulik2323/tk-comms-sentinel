// routes/reports.js — הרצת דוחות + ניהול תזמון
const express = require('express');
const router  = express.Router();
const { getDb }          = require('../db/database');
const { requireAdmin }   = require('../middleware/auth');
const { generateReport, toCSV, GENERATORS } = require('../services/reports');

const VALID_TYPES = Object.keys(GENERATORS);
const VALID_CRON  = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

// GET /api/reports/types — רשימת סוגים אפשריים
router.get('/types', requireAdmin, (req, res) => {
  res.json([
    { type: 'uptime',        label: 'זמינות מכשירים (Uptime %)', params: [{ name: 'period_days', label: 'ימים אחרונים', default: 7 }] },
    { type: 'top_ports',     label: 'פורטים עם תעבורה גבוהה',   params: [{ name: 'limit',       label: 'מספר פורטים',   default: 20 }] },
    { type: 'alert_history', label: 'היסטוריית התראות',          params: [{ name: 'period_days', label: 'ימים אחרונים', default: 7 }] },
    { type: 'port_errors',   label: 'שגיאות פורטים',             params: [{ name: 'min_errors',  label: 'מינימום שגיאות', default: 0 }] },
  ]);
});

// GET /api/reports/run?type=uptime&period_days=7[&format=csv]
router.get('/run', requireAdmin, (req, res) => {
  const { type, format, ...params } = req.query;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `סוג דוח לא תקין. אפשרויות: ${VALID_TYPES.join(', ')}` });
  }

  // המר פרמטרים מספריים
  const numericParams = {};
  for (const [k, v] of Object.entries(params)) {
    const n = Number(v);
    numericParams[k] = Number.isFinite(n) ? n : v;
  }

  try {
    const report = generateReport(type, numericParams);

    if (format === 'csv') {
      const csv = toCSV(report.headers, report.rows);
      const filename = `${type}_${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // BOM לעברית בExcel
      return res.send('﻿' + csv);
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/schedules
router.get('/schedules', requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM report_schedules ORDER BY id DESC').all();
  res.json(rows.map(r => ({ ...r, params: r.params ? JSON.parse(r.params) : {} })));
});

// POST /api/reports/schedules
router.post('/schedules', requireAdmin, (req, res) => {
  const { name, report_type, params, cron_expr, email_to, enabled } = req.body;

  if (!name || !report_type || !cron_expr) {
    return res.status(400).json({ error: 'name, report_type, cron_expr נדרשים' });
  }
  if (!VALID_TYPES.includes(report_type)) {
    return res.status(400).json({ error: 'סוג דוח לא תקין' });
  }
  if (!VALID_CRON.test(cron_expr.trim())) {
    return res.status(400).json({ error: 'ביטוי cron לא תקין (5 שדות: דק שעה יום-בחודש חודש יום-בשבוע)' });
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO report_schedules (name, report_type, params, cron_expr, email_to, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, report_type, params ? JSON.stringify(params) : null, cron_expr.trim(), email_to || null, enabled !== false ? 1 : 0);

  // רענן את המתזמן
  try { require('../services/report-scheduler').reload(); } catch (_) {}

  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/reports/schedules/:id
router.put('/schedules/:id', requireAdmin, (req, res) => {
  const { name, cron_expr, email_to, enabled, params } = req.body;
  const db = getDb();

  if (cron_expr && !VALID_CRON.test(cron_expr.trim())) {
    return res.status(400).json({ error: 'ביטוי cron לא תקין' });
  }

  db.prepare(`
    UPDATE report_schedules
    SET name = COALESCE(?, name),
        cron_expr = COALESCE(?, cron_expr),
        email_to  = COALESCE(?, email_to),
        enabled   = COALESCE(?, enabled),
        params    = COALESCE(?, params)
    WHERE id = ?
  `).run(name || null, cron_expr?.trim() || null, email_to || null,
         enabled != null ? (enabled ? 1 : 0) : null,
         params ? JSON.stringify(params) : null, req.params.id);

  try { require('../services/report-scheduler').reload(); } catch (_) {}
  res.json({ ok: true });
});

// DELETE /api/reports/schedules/:id
router.delete('/schedules/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM report_schedules WHERE id = ?').run(req.params.id);
  try { require('../services/report-scheduler').reload(); } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
