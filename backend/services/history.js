// services/history.js — שמירת נתונים היסטוריים וניקוי ישנים
const { getDb, getSetting } = require('../db/database');

// שמור sample של metrics מכשיר
function saveMetrics(deviceId, { cpu_pct, mem_pct, total_in_bps, total_out_bps }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO metrics (device_id, ts, cpu_pct, mem_pct, total_in_bps, total_out_bps)
    VALUES (?, unixepoch(), ?, ?, ?, ?)
  `).run(deviceId, cpu_pct ?? null, mem_pct ?? null, total_in_bps ?? 0, total_out_bps ?? 0);
}

// קבל היסטוריה של מכשיר לטווח זמן
function getMetricsHistory(deviceId, fromTs, toTs) {
  const db = getDb();
  return db.prepare(`
    SELECT ts, cpu_pct, mem_pct, total_in_bps, total_out_bps
    FROM metrics
    WHERE device_id = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(deviceId, fromTs, toTs);
}

// מחק metrics ישנים מעבר ל-retention_days
function pruneOldMetrics() {
  const db = getDb();
  const retentionDays = parseInt(getSetting('retention_days') || '7');
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;

  const result = db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[History] ניקוי ${result.changes} רשומות ישנות מ-metrics`);
  }
}

// פרטי uptime ו-availability
function getDeviceUptime(deviceId, hours = 24) {
  const db = getDb();
  const fromTs = Math.floor(Date.now() / 1000) - hours * 3600;

  const rows = db.prepare(`
    SELECT COUNT(*) as total FROM metrics
    WHERE device_id = ? AND ts >= ?
  `).get(deviceId, fromTs);

  return rows.total;
}

module.exports = { saveMetrics, getMetricsHistory, pruneOldMetrics, getDeviceUptime };
