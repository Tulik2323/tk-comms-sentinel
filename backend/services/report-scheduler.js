// services/report-scheduler.js — מפעיל דוחות מתוזמנים לפי הגדרות ה-DB
const cron     = require('node-cron');
const nodemailer = require('nodemailer');
const { getDb, getSetting } = require('../db/database');
const { decrypt }           = require('./secrets');
const { generateReport, toCSV } = require('./reports');
const { tlsOptions }            = require('./smtp');
const { logAudit }             = require('../db/audit');

const _tasks = new Map();   // id -> cron.ScheduledTask

async function sendScheduledReport(schedule) {
  try {
    const params = schedule.params ? JSON.parse(schedule.params) : {};
    const report = generateReport(schedule.report_type, params);
    const csv    = '﻿' + toCSV(report.headers, report.rows);   // BOM לעברית

    const host = getSetting('smtp_host');
    const port = parseInt(getSetting('smtp_port') || '25');
    const to   = schedule.email_to;

    if (!host || !to) {
      logAudit('warn', 'reports', `דוח "${schedule.name}" הורץ אך אין SMTP/כתובת מייל — לא נשלח`, {});
      return;
    }

    const transporter = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: getSetting('smtp_user') ? { user: getSetting('smtp_user'), pass: decrypt(getSetting('smtp_pass') || '') } : undefined,
      tls: tlsOptions(),
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
    });

    const filename = `${schedule.report_type}_${new Date().toISOString().slice(0, 10)}.csv`;
    await transporter.sendMail({
      from:    getSetting('smtp_from') || 'netmonitor@company.local',
      to,
      subject: `[TK COMMS SENTINEL] ${report.title}`,
      text:    `דוח "${report.title}" מצורף.\nשורות: ${report.rows.length}`,
      attachments: [{ filename, content: csv, encoding: 'utf8' }],
    });

    logAudit('info', 'reports', `דוח "${schedule.name}" נשלח ל-${to}`, {});
  } catch (err) {
    logAudit('error', 'reports', `כשל בשליחת דוח "${schedule.name}": ${err.message}`, {});
  } finally {
    try {
      getDb().prepare('UPDATE report_schedules SET last_run = unixepoch() WHERE id = ?').run(schedule.id);
    } catch (_) {}
  }
}

function reload() {
  // בטל את כל המשימות הקיימות
  for (const task of _tasks.values()) {
    try { task.stop(); } catch (_) {}
  }
  _tasks.clear();

  let db;
  try { db = getDb(); } catch (_) { return; }

  const schedules = db.prepare('SELECT * FROM report_schedules WHERE enabled = 1').all();
  for (const s of schedules) {
    try {
      const task = cron.schedule(s.cron_expr, () => sendScheduledReport(s), { timezone: 'Asia/Jerusalem' });
      _tasks.set(s.id, task);
    } catch (e) {
      logAudit('warn', 'reports', `cron לא תקין לדוח "${s.name}": ${e.message}`, {});
    }
  }

  if (schedules.length > 0) {
    console.log(`[Reports] ${schedules.length} דוחות מתוזמנים פעילים`);
  }
}

module.exports = { reload };
