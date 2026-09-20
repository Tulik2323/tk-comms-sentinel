// routes/reports.js — הרצת דוחות + ניהול תזמון
const express = require('express');
const router  = express.Router();
const { getDb }          = require('../db/database');
const { requireAdmin }   = require('../middleware/auth');
const { generateReport, toCSV, GENERATORS } = require('../services/reports');
const { cleanText }      = require('../services/validate');
const { logAudit }       = require('../db/audit');

const VALID_TYPES = Object.keys(GENERATORS);
const VALID_CRON  = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

// הפרמטרים שכל סוג דוח מקבל, עם טווח מותר. ערך אחר נדחה במקום להגיע לחישוב ול-SQL, ופרמטר לא מוכר נזרק.
const PARAM_SPECS = {
  uptime:        { period_days: [1, 365] },
  alert_history: { period_days: [1, 365] },
  top_ports:     { limit:       [1, 1000] },
  port_errors:   { min_errors:  [0, 1000000000] },
};

function normalizeReportParams(type, raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { error: 'params לא תקין' };
  }
  const out = {};
  for (const [key, [min, max]] of Object.entries(PARAM_SPECS[type] || {})) {
    const v = raw ? raw[key] : undefined;
    if (v === undefined || v === null || v === '') continue;
    // ?period_days[]=1 מגיע כמערך, ו-Number(['1']) הופך אותו ל-1
    const n = typeof v === 'object' ? NaN : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { error: `${key} חייב להיות מספר שלם בין ${min} ל-${max}` };
    }
    out[key] = n;
  }
  return { params: out };
}

// נמענים: כתובת אחת או כמה, מופרדות בפסיק או בנקודה-פסיק. מחזיר { value } או { error }
const EMAIL_RE = /^[^\s@,;<>()"'\\]+@[^\s@,;<>()"'\\]+\.[^\s@,;<>()"'\\]+$/;
const MAX_RECIPIENTS = 10;
function parseRecipients(v) {
  if (typeof v !== 'string') return { error: 'כתובת המייל לא תקינה' };
  const list = v.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  if (list.length === 0 || list.length > MAX_RECIPIENTS || !list.every(a => a.length <= 254 && EMAIL_RE.test(a))) {
    return { error: 'כתובת המייל לא תקינה' };
  }
  return { value: list.join(', ') };
}

const validId = (v) => /^\d{1,9}$/.test(String(v));
const provided = (v) => v !== undefined && v !== null && v !== '';

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
  const { type, format, ...rawParams } = req.query;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `סוג דוח לא תקין. אפשרויות: ${VALID_TYPES.join(', ')}` });
  }

  const checked = normalizeReportParams(type, rawParams);
  if (checked.error) return res.status(400).json({ error: checked.error });

  try {
    const report = generateReport(type, checked.params);

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
  res.json(rows.map(r => {
    let params = {};
    try { params = r.params ? JSON.parse(r.params) : {}; } catch (_) {}
    return { ...r, params };
  }));
});

// POST /api/reports/schedules
router.post('/schedules', requireAdmin, (req, res) => {
  const { name, report_type, params, cron_expr, email_to, enabled } = req.body || {};

  if (!name || !report_type || !cron_expr) {
    return res.status(400).json({ error: 'name, report_type, cron_expr נדרשים' });
  }
  const cleanName = cleanText(name, 100);
  if (!cleanName) return res.status(400).json({ error: 'שם התזמון לא תקין (עד 100 תווים)' });
  if (!VALID_TYPES.includes(report_type)) {
    return res.status(400).json({ error: 'סוג דוח לא תקין' });
  }
  if (typeof cron_expr !== 'string' || !VALID_CRON.test(cron_expr.trim())) {
    return res.status(400).json({ error: 'ביטוי cron לא תקין (5 שדות: דק שעה יום-בחודש חודש יום-בשבוע)' });
  }
  const recipients = provided(email_to) ? parseRecipients(email_to) : { value: null };
  if (recipients.error) return res.status(400).json({ error: recipients.error });
  const checked = normalizeReportParams(report_type, params);
  if (checked.error) return res.status(400).json({ error: checked.error });

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO report_schedules (name, report_type, params, cron_expr, email_to, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cleanName, report_type, Object.keys(checked.params).length ? JSON.stringify(checked.params) : null,
         cron_expr.trim(), recipients.value, enabled !== false ? 1 : 0);

  // רענן את המתזמן
  try { require('../services/report-scheduler').reload(); } catch (_) {}

  logAudit('info', 'admin', 'report_schedule_created',
    { name: cleanName, report_type, cron_expr: cron_expr.trim() }, { username: req.user.username, ip: req.ip });
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

// PUT /api/reports/schedules/:id
router.put('/schedules/:id', requireAdmin, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'מזהה תזמון לא תקין' });
  const db  = getDb();
  const cur = db.prepare('SELECT id, name, report_type FROM report_schedules WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'התזמון לא נמצא' });

  const { name, cron_expr, email_to, enabled, params } = req.body || {};

  let cleanName = null;
  if (provided(name)) {
    cleanName = cleanText(name, 100);
    if (!cleanName) return res.status(400).json({ error: 'שם התזמון לא תקין (עד 100 תווים)' });
  }
  if (provided(cron_expr) && (typeof cron_expr !== 'string' || !VALID_CRON.test(cron_expr.trim()))) {
    return res.status(400).json({ error: 'ביטוי cron לא תקין' });
  }
  const recipients = provided(email_to) ? parseRecipients(email_to) : { value: null };
  if (recipients.error) return res.status(400).json({ error: recipients.error });
  let paramsJson = null;
  if (params !== undefined && params !== null) {
    const checked = normalizeReportParams(cur.report_type, params);
    if (checked.error) return res.status(400).json({ error: checked.error });
    paramsJson = Object.keys(checked.params).length ? JSON.stringify(checked.params) : null;
  }

  db.prepare(`
    UPDATE report_schedules
    SET name = COALESCE(?, name),
        cron_expr = COALESCE(?, cron_expr),
        email_to  = COALESCE(?, email_to),
        enabled   = COALESCE(?, enabled),
        params    = COALESCE(?, params)
    WHERE id = ?
  `).run(cleanName, provided(cron_expr) ? cron_expr.trim() : null, recipients.value,
         enabled != null ? (enabled ? 1 : 0) : null,
         paramsJson, cur.id);

  try { require('../services/report-scheduler').reload(); } catch (_) {}
  logAudit('info', 'admin', 'report_schedule_updated', { name: cleanName || cur.name }, { username: req.user.username, ip: req.ip });
  res.json({ ok: true });
});

// DELETE /api/reports/schedules/:id
router.delete('/schedules/:id', requireAdmin, (req, res) => {
  const db  = getDb();
  const cur = validId(req.params.id) ? db.prepare('SELECT id, name FROM report_schedules WHERE id = ?').get(req.params.id) : null;
  if (cur) {
    db.prepare('DELETE FROM report_schedules WHERE id = ?').run(cur.id);
    try { require('../services/report-scheduler').reload(); } catch (_) {}
    logAudit('info', 'admin', 'report_schedule_deleted', { name: cur.name }, { username: req.user.username, ip: req.ip });
  }
  res.json({ ok: true });
});

module.exports = router;
