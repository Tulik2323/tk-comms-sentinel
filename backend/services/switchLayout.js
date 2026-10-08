// services/switchLayout.js — נתונים לתצוגת "Switch Layout": הפורטים של כל חבר במחסנית, מוצמדים לחזית הסוויץ'
//
// התצוגה היא לקריאה בלבד: כל מה שכאן נלקח ממה שה-poller כבר שמר (פורטים, MAC, LLDP, VLAN, חומרה).
// שמות הפורטים נקראים לפי היצרן:
//   Aruba CX            1/1/17          חבר/1/פורט
//   ArubaOS-Switch      17  או  1/17     (מחסנית: חבר/פורט). A1..A4 = פורטי uplink של מודול
//   HPE Comware 5130    GigabitEthernet1/0/17 ו-Ten-GigabitEthernet1/0/49      חבר/0/פורט
//   HP 10508 (שלדה)     GigabitEthernet1/7/0/17      חבר/סלוט/0/פורט
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../db/database');

// מפתחות התצוגות שיש להן תמונת חזית ומיקומי פורטים (frontend/src/lib/switchLayouts.json)
const LAYOUT_KEYS = ['6300M-48', '5130-48', '5130-24', '2930F-48', '2930M-48', '2930M-24', '8360-48Y6C'];

// התמונות הן של היצרן והן לא נארזות בקובץ ההתקנה: הן יושבות בתיקיית הנתונים של השרת, ואפשר להעלות אותן ממסך Layout.
function imagesDir() {
  if (process.env.TKCS_SWITCH_IMAGES_DIR) return process.env.TKCS_SWITCH_IMAGES_DIR;
  return path.join(process.env.TKCS_DATA_DIR || path.join(__dirname, '..'), 'switch-images');
}
const IMAGE_EXT = ['.png', '.jpg'];
function imagePath(key) {
  if (!LAYOUT_KEYS.includes(key)) return null;
  for (const ext of IMAGE_EXT) {
    const p = path.join(imagesDir(), key + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function familyOf(d) {
  const v = d.vendor || '', m = d.model || '';
  if (/Aruba CX/i.test(v))            return /8360/.test(m) ? '8360' : /6300/.test(m) ? '6300M' : null;
  if (/Aruba|ProCurve/i.test(v))      return /2930M/.test(m) ? '2930M' : /2930F/.test(m) ? '2930F' : null;
  if (/Comware/i.test(v))             return /10508/.test(m) ? '10508' : /5130/.test(m) ? '5130' : null;
  return null;
}

// מפרק שם ממשק לחבר / סלוט / פורט. null = לא פורט פיזי (VLAN, lag, ניהול, פיצול 54:1 ...)
function parsePort(family, name) {
  const n = String(name || '');
  let m;
  if (family === '6300M' || family === '8360') {
    if ((m = n.match(/^(\d+)\/(\d+)\/(\d+)$/))) return { member: +m[1], slot: +m[2], port: +m[3] };
    return null;
  }
  if (family === '2930M' || family === '2930F') {
    if ((m = n.match(/^(\d+)\/([A-Z]?)(\d+)$/))) return { member: +m[1], slot: 0, port: +m[3], letter: m[2] };
    if ((m = n.match(/^([A-Z]?)(\d+)$/)))        return { member: 1, slot: 0, port: +m[2], letter: m[1] };
    return null;
  }
  if (family === '5130') {
    if ((m = n.match(/^(?:Ten-)?GigabitEthernet(\d+)\/(\d+)\/(\d+)$/))) return { member: +m[1], slot: +m[2], port: +m[3] };
    return null;
  }
  if (family === '10508') {
    if ((m = n.match(/^(Ten-)?GigabitEthernet(\d+)\/(\d+)\/(\d+)\/(\d+)$/))) {
      return { member: +m[2], slot: +m[3], port: +m[5], ten: !!m[1] };
    }
    return null;
  }
  return null;
}

// איזו תצוגה מתאימה לחבר, לפי המשפחה ומספר הפורטים שלו. null = אין תצוגה מוכנה, ומציירים סרטוט נקי.
function layoutKeyFor(family, maxN, numericMax) {
  if (family === '6300M') return maxN >= 48 ? '6300M-48' : null;
  if (family === '8360')  return maxN >= 54 ? '8360-48Y6C' : null;
  if (family === '2930F') return maxN >= 52 ? '2930F-48' : null;
  if (family === '2930M') return numericMax >= 48 ? '2930M-48' : numericMax >= 24 && numericMax <= 28 ? '2930M-24' : null;
  if (family === '5130')  return maxN >= 49 ? '5130-48' : maxN >= 25 && maxN <= 28 ? '5130-24' : null;
  return null;
}

// רשימת הנקודות הקצה של Inventory (סיווג לפי OUI/hostname/VLAN) מחושבת בכבדות, ולכן נשמרת חצי דקה
let _inv = { at: 0, byDevice: new Map() };
function inventoryByDevice(db) {
  if (Date.now() - _inv.at < 30000) return _inv.byDevice;
  const { loadInventory } = require('../routes/inventory');
  const byDevice = new Map();
  for (const r of loadInventory(db)) {
    if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, new Map());
    const perPort = byDevice.get(r.device_id);
    if (!perPort.has(r.if_name)) perPort.set(r.if_name, []);
    perPort.get(r.if_name).push(r);
  }
  _inv = { at: Date.now(), byDevice };
  return byDevice;
}

const validSpeed = (bps) => (bps > 0 && bps < 4294967295 ? Number(bps) : null);

function buildLayout(device) {
  const db = getDb();
  const family = familyOf(device);
  if (!family) return { supported: false, device: { id: device.id, name: device.name || device.ip, ip: device.ip, model: device.model } };

  const rows = db.prepare(`
    SELECT if_index, if_name, if_descr, if_alias, if_speed, oper_status, admin_status,
           in_bps, out_bps, in_errors, out_errors, pvid
    FROM ports WHERE device_id = ? ORDER BY if_index
  `).all(device.id);

  const vlanNames = new Map(db.prepare('SELECT vlan_id, name FROM vlan_names').all().map(v => [v.vlan_id, v.name]));
  const lldp = new Map(db.prepare(
    'SELECT local_port_index, remote_sys_name, remote_port_id FROM lldp_links WHERE local_device_id = ? AND local_port_index IS NOT NULL'
  ).all(device.id).map(l => [l.local_port_index, l]));
  const macCount = new Map(db.prepare(`
    SELECT phys_if_index, COUNT(DISTINCT mac_address) AS n FROM mac_entries
    WHERE device_id = ? AND phys_if_index IS NOT NULL GROUP BY phys_if_index
  `).all(device.id).map(r => [r.phys_if_index, r.n]));
  const endpoints = inventoryByDevice(db).get(device.id) || new Map();

  let hw = null;
  try { hw = JSON.parse(device.hw_status || 'null'); } catch (_) {}

  // 1. מפרקים כל פורט, ומחשבים לכל חבר את הפורט הגבוה ביותר
  const byMember = new Map();
  for (const r of rows) {
    const name = r.if_name || r.if_descr;
    const p = parsePort(family, name);
    if (!p) continue;
    if (!byMember.has(p.member)) byMember.set(p.member, { numericMax: 0, list: [] });
    const g = byMember.get(p.member);
    if (!p.letter) g.numericMax = Math.max(g.numericMax, p.port);
    g.list.push({ r, name, p });
  }

  const members = [];
  for (const [member, g] of [...byMember].sort((a, b) => a[0] - b[0])) {
    // פורטי uplink בשם A1..A4 (ArubaOS) ממוספרים אחרי הפורטים הרגילים: 25..28 בדגם 24 פורטים, 49..52 בדגם 48
    const copperEnd = g.numericMax >= 48 ? 48 : g.numericMax;
    const ports = g.list.map(({ r, name, p }) => {
      const n = p.letter ? copperEnd + p.port : p.port;
      const eps = (endpoints.get(name) || []).slice(0, 6).map(e => ({
        mac: e.mac_address, ip: e.ip_address || null, hostname: e.hostname || null, vendor: e.vendor || null,
        category: e.category, category_meta: e.category_meta || null, vlan: e.vlan || null, vlan_name: e.vlan_name || null,
      }));
      const l = lldp.get(r.if_index);
      return {
        id: r.if_index, name, n, slot: p.slot, ten: !!p.ten,
        alias: r.if_alias || null, oper: r.oper_status, admin: r.admin_status,
        speed: validSpeed(r.if_speed), vlan: r.pvid || null, vlan_name: r.pvid ? (vlanNames.get(r.pvid) || null) : null,
        in_bps: r.in_bps || 0, out_bps: r.out_bps || 0, errors: (r.in_errors || 0) + (r.out_errors || 0),
        lldp: l ? { name: l.remote_sys_name || null, port: l.remote_port_id || null } : null,
        mac_count: macCount.get(r.if_index) || 0, endpoints: eps,
      };
    }).sort((a, b) => a.slot - b.slot || a.n - b.n);

    const maxN = Math.max(0, ...ports.map(p => p.n));
    const key = layoutKeyFor(family, maxN, g.numericMax);
    members.push({
      member, layout: key, has_image: key ? !!imagePath(key) : false,
      port_count: ports.length, ports,
      hw: hw && hw.members && hw.members[member] ? hw.members[member] : { psus: [], fans: [] },
    });
  }

  return {
    supported: true, family,
    device: { id: device.id, name: device.name || device.ip, ip: device.ip, model: device.model, status: device.status, stack_members: device.stack_members },
    temps: hw && hw.temps ? hw.temps : [],
    hw_known: !!(hw && hw.members),
    members,
  };
}

module.exports = { LAYOUT_KEYS, imagesDir, imagePath, familyOf, parsePort, layoutKeyFor, buildLayout, IMAGE_EXT };
