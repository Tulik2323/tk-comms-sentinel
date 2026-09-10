// routes/trends.js — ניתוח מגמות שבועי/חודשי + AI (אופציונלי)
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// GET /api/trends?days=7
// מחזיר: פורטים בעייתיים, מכשירים עם הרבה התראות, מגמות bandwidth/CPU
router.get('/', requireAuth, (req, res) => {
  const db   = getDb();
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // פורטים עם הכי הרבה שינויי סטטוס (flapping)
  const flappingPorts = db.prepare(`
    SELECT
      pc.device_id, d.name AS device_name, d.ip AS device_ip,
      pc.if_index, pc.if_name,
      COUNT(*) AS change_count,
      SUM(CASE WHEN pc.attribute = 'admin_status' THEN 1 ELSE 0 END) AS admin_changes,
      MAX(pc.changed_at) AS last_change
    FROM port_changes pc
    JOIN devices d ON d.id = pc.device_id
    WHERE pc.changed_at >= ? AND pc.attribute IN ('admin_status','if_speed')
    GROUP BY pc.device_id, pc.if_index
    HAVING change_count >= 2
    ORDER BY change_count DESC
    LIMIT 20
  `).all(since);

  // פורטים עם שגיאות גבוהות (מה-ports table כרגע)
  const errorPorts = db.prepare(`
    SELECT
      p.device_id, d.name AS device_name, d.ip AS device_ip,
      p.if_index, p.if_name, p.if_alias,
      p.in_errors, p.out_errors, (p.in_errors + p.out_errors) AS total_errors,
      p.in_bps, p.out_bps, p.if_speed
    FROM ports p
    JOIN devices d ON d.id = p.device_id
    WHERE (p.in_errors + p.out_errors) > 0 AND d.status = 'up'
    ORDER BY total_errors DESC
    LIMIT 20
  `).all();

  // מכשירים עם הכי הרבה התראות בתקופה
  const alertDevices = db.prepare(`
    SELECT
      ae.device_id, d.name AS device_name, d.ip AS device_ip,
      COUNT(*) AS alert_count,
      COUNT(DISTINCT ae.metric) AS metric_types,
      GROUP_CONCAT(DISTINCT ae.metric) AS metrics,
      MAX(ae.sent_at) AS last_alert,
      AVG(ae.value) AS avg_value
    FROM alert_events ae
    JOIN devices d ON d.id = ae.device_id
    WHERE ae.sent_at >= ?
    GROUP BY ae.device_id
    ORDER BY alert_count DESC
    LIMIT 10
  `).all(since);

  // מכשירים עם CPU גבוה ממוצע בתקופה
  const highCpuDevices = db.prepare(`
    SELECT
      m.device_id, d.name AS device_name, d.ip AS device_ip,
      ROUND(AVG(m.cpu_pct), 1) AS avg_cpu,
      ROUND(MAX(m.cpu_pct), 1) AS max_cpu,
      COUNT(*) AS sample_count
    FROM metrics m
    JOIN devices d ON d.id = m.device_id
    WHERE m.ts >= ? AND m.cpu_pct IS NOT NULL
    GROUP BY m.device_id
    HAVING avg_cpu > 50
    ORDER BY avg_cpu DESC
    LIMIT 10
  `).all(since);

  // שינויי פורטים לפי יום (גרף)
  const dailyChanges = db.prepare(`
    SELECT
      DATE(changed_at, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS total_changes,
      COUNT(DISTINCT device_id) AS affected_devices
    FROM port_changes
    WHERE changed_at >= ?
    GROUP BY day
    ORDER BY day
  `).all(since);

  // סיכום כללי
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices WHERE status = 'up')   AS devices_up,
      (SELECT COUNT(*) FROM devices WHERE status = 'down') AS devices_down,
      (SELECT COUNT(*) FROM alert_events WHERE sent_at >= ?) AS total_alerts,
      (SELECT COUNT(*) FROM port_changes  WHERE changed_at >= ?) AS total_port_changes
  `).get(since, since);

  res.json({
    days,
    since,
    summary,
    flappingPorts,
    errorPorts,
    alertDevices,
    highCpuDevices,
    dailyChanges,
  });
});

// POST /api/trends/ai-analyze — שלח נתונים ל-Claude ו-קבל המלצות
// דורש CLAUDE_API_KEY ב-.env. אם לא הוגדר — מחזיר 503.
router.post('/ai-analyze', requireAuth, async (req, res) => {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI_NOT_CONFIGURED',
      message: 'CLAUDE_API_KEY לא הוגדר ב-.env. הפיצ\'ר אופציונלי ודורש גישה לאינטרנט.'
    });
  }

  const { trendData } = req.body;
  if (!trendData) return res.status(400).json({ error: 'trendData נדרש' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey });

    const { days, summary, flappingPorts, errorPorts, alertDevices, highCpuDevices } = trendData;

    const prompt = buildAnalysisPrompt(days, summary, flappingPorts, errorPorts, alertDevices, highCpuDevices);

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const analysis = message.content[0]?.text || '';
    res.json({ analysis });
  } catch (err) {
    console.error('[Trends AI] שגיאה:', err.message);
    res.status(500).json({ error: 'שגיאה בתקשורת עם Claude API', detail: err.message });
  }
});

function buildAnalysisPrompt(days, summary, flappingPorts, errorPorts, alertDevices, highCpuDevices) {
  const lines = [
    `אתה מנתח רשת לבית חולים. נתח את הנתונים הבאים מ-${days} הימים האחרונים והמלץ על פעולות תיקון.`,
    `ענה בעברית בלבד. הצג את הממצאים ברשימה מסודרת לפי חומרה. כלול: הבעיה, הסיבה הסבירה, הפעולה המומלצת.`,
    '',
    `=== סיכום כללי ===`,
    `מכשירים UP: ${summary?.devices_up ?? '?'} | DOWN: ${summary?.devices_down ?? '?'}`,
    `סה"כ התראות: ${summary?.total_alerts ?? 0} | שינויי פורטים: ${summary?.total_port_changes ?? 0}`,
  ];

  if (flappingPorts?.length > 0) {
    lines.push('', '=== פורטים עם שינויים תכופים (Flapping) ===');
    for (const p of flappingPorts.slice(0, 8)) {
      lines.push(`• ${p.device_name} (${p.device_ip}) — פורט ${p.if_name || p.if_index}: ${p.change_count} שינויים`);
    }
  }

  if (errorPorts?.length > 0) {
    lines.push('', '=== פורטים עם שגיאות גבוהות ===');
    for (const p of errorPorts.slice(0, 8)) {
      lines.push(`• ${p.device_name} (${p.device_ip}) — ${p.if_alias || p.if_name || p.if_index}: ${p.total_errors.toLocaleString()} שגיאות`);
    }
  }

  if (alertDevices?.length > 0) {
    lines.push('', '=== מכשירים עם הכי הרבה התראות ===');
    for (const d of alertDevices.slice(0, 5)) {
      lines.push(`• ${d.device_name} (${d.device_ip}): ${d.alert_count} התראות | מטריקות: ${d.metrics}`);
    }
  }

  if (highCpuDevices?.length > 0) {
    lines.push('', '=== מכשירים עם CPU גבוה ===');
    for (const d of highCpuDevices.slice(0, 5)) {
      lines.push(`• ${d.device_name} (${d.device_ip}): ממוצע ${d.avg_cpu}% | מקסימום ${d.max_cpu}%`);
    }
  }

  lines.push('', 'המלץ על 3-5 פעולות קונקרטיות שצוות ה-IT יכול לבצע כדי לשפר את יציבות הרשת.');
  return lines.join('\n');
}

module.exports = router;
