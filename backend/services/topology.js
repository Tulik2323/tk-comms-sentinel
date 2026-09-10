// services/topology.js — בניית גרף טופולוגיה מנתוני LLDP שב-DB
const { getDb } = require('../db/database');

// קבל גרף טופולוגיה מלא
// includeStubs: אם true — כולל עמדות קצה שאינן ב-DB (ברירת מחדל: false)
// מחזיר { nodes, edges } בפורמט שמתאים ל-vis-network בצד הלקוח
function getTopologyGraph({ includeStubs = false } = {}) {
  const db = getDb();

  // כל המכשירים הידועים
  const devices = db.prepare(`
    SELECT id, name, ip, status, sys_name, sys_descr
    FROM devices
  `).all();

  // כל קשרי LLDP שנראו ב-24 שעות אחרונות
  const links = db.prepare(`
    SELECT l.local_device_id, l.local_port_index,
           l.remote_chassis_id, l.remote_port_id, l.remote_sys_name,
           d_remote.id AS remote_device_id
    FROM lldp_links l
    LEFT JOIN devices d_remote ON (
      d_remote.sys_name = l.remote_sys_name
      OR d_remote.ip = l.remote_sys_name
    )
    WHERE l.last_seen > unixepoch() - 86400
  `).all();

  // metrics נוכחיות לצביעת הצמתים
  const latestMetrics = db.prepare(`
    SELECT m.device_id, m.total_in_bps, m.total_out_bps, m.cpu_pct
    FROM metrics m
    INNER JOIN (
      SELECT device_id, MAX(ts) AS max_ts
      FROM metrics GROUP BY device_id
    ) latest ON m.device_id = latest.device_id AND m.ts = latest.max_ts
  `).all();

  const metricsMap = {};
  for (const m of latestMetrics) metricsMap[m.device_id] = m;

  // ספור כמה קישורים לציוד מנוטר יש לכל מכשיר (לסימון ריכוז)
  const deviceEdgeCount = {}; // device_id -> count of known-device neighbors
  for (const link of links) {
    if (link.remote_device_id) {
      deviceEdgeCount[link.local_device_id]  = (deviceEdgeCount[link.local_device_id]  || 0) + 1;
      deviceEdgeCount[link.remote_device_id] = (deviceEdgeCount[link.remote_device_id] || 0) + 1;
    }
  }

  // בנה nodes
  const nodes = devices.map(d => {
    const m = metricsMap[d.id] || {};
    const maxBps = getDeviceMaxBps(d.id);
    const utilIn  = maxBps ? (m.total_in_bps  || 0) / maxBps * 100 : 0;
    const utilOut = maxBps ? (m.total_out_bps || 0) / maxBps * 100 : 0;
    const util    = Math.max(utilIn, utilOut);

    let color = '#22c55e'; // ירוק — OK
    if (d.status === 'down') color = '#ef4444'; // אדום — DOWN
    else if (util > 80)      color = '#ef4444'; // אדום — עומס גבוה
    else if (util > 60)      color = '#f97316'; // כתום — עומס בינוני

    // ריכוז = מכשיר שמחובר ל-2+ ציודים מנוטרים
    const connCount     = deviceEdgeCount[d.id] || 0;
    const isConcentrator = connCount >= 2;

    const label = (d.name || d.sys_name || d.ip) +
                  (isConcentrator ? '\n(ריכוז)' : '');

    return {
      id:              d.id,
      label,
      title:           `${d.ip}\n${d.sys_descr || ''}`,
      color:           { background: color, border: isConcentrator ? '#facc15' : color },
      borderWidth:     isConcentrator ? 3 : 2,
      font:            { color: '#ffffff' },
      shape:           'box',
      status:          d.status,
      util:            Math.round(util),
      in_bps:          m.total_in_bps  || 0,
      out_bps:         m.total_out_bps || 0,
      cpu_pct:         m.cpu_pct       || 0,
      isConcentrator,
      connCount,
    };
  });

  // בנה edges + stub nodes לשכנים לא מזוהים
  const edges     = [];
  const seen      = new Set();
  const stubNodes = new Map(); // chassis_id -> stub node

  for (const link of links) {
    const fromId = link.local_device_id;
    let toId     = link.remote_device_id;

    // שכן לא בDB
    if (!toId && link.remote_chassis_id) {
      if (!includeStubs) continue; // מסנן עמדות קצה כברירת מחדל

      const stubId = `stub_${link.remote_chassis_id}`;
      if (!stubNodes.has(stubId)) {
        stubNodes.set(stubId, {
          id:     stubId,
          label:  link.remote_sys_name || link.remote_chassis_id.substring(0, 14),
          title:  `לא ב-DB\n${link.remote_sys_name || ''}\n${link.remote_chassis_id}`,
          color:  { background: '#4b5563', border: '#6b7280' },
          font:   { color: '#d1d5db' },
          shape:  'box',
          status: 'unknown',
          util: 0, in_bps: 0, out_bps: 0, cpu_pct: 0,
        });
      }
      toId = stubId;
    }

    if (!toId) continue;

    // מנע כפילויות דו-כיווניות
    const edgeKey = [String(fromId), String(toId)].sort().join('-');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    // בחר עובי ורוחב לפי bandwidth
    const mFrom = metricsMap[fromId] || {};
    const totalBps = (mFrom.total_in_bps || 0) + (mFrom.total_out_bps || 0);
    const maxBps   = getDeviceMaxBps(fromId);
    const util     = maxBps ? totalBps / maxBps * 100 : 0;

    let edgeColor = '#22c55e';
    let width     = 1;
    if (typeof fromId === 'number') {
      if (util > 80) { edgeColor = '#ef4444'; width = 4; }
      else if (util > 60) { edgeColor = '#f97316'; width = 2; }
      else if (totalBps > 500e6) { edgeColor = '#f97316'; width = 2; }
    } else {
      edgeColor = '#6b7280';
    }

    edges.push({
      id:     `${fromId}-${toId}`,
      from:   fromId,
      to:     toId,
      color:  { color: edgeColor, hover: '#ffffff' },
      width,
      title:  formatBps(totalBps),
      bps:    totalBps,
      dashes: typeof toId === 'string',
    });
  }

  // הוסף stub nodes לרשימה (רק אם includeStubs)
  if (includeStubs) nodes.push(...stubNodes.values());

  return { nodes, edges };
}

// עזר: מהירות מקסימלית של מכשיר
function getDeviceMaxBps(deviceId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(if_speed) as max_speed FROM ports
    WHERE device_id = ? AND oper_status = 'up'
  `).get(deviceId);
  return row?.max_speed || 1e9; // ברירת מחדל 1Gbps
}

// עזר: פורמט bps ל-"12.5 Mbps"
function formatBps(bps) {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bps)} bps`;
}

module.exports = { getTopologyGraph };
