// routes/inventory.js — Inventory: OUI-based endpoint classification
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const fs   = require('fs');

// ---- OUI lookup ----

let _ouiMap = null;

function getOuiMap() {
  if (_ouiMap) return _ouiMap;
  _ouiMap = new Map();
  const p = path.join(__dirname, '..', 'data', 'oui.json');
  if (!fs.existsSync(p)) return _ouiMap;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(obj)) _ouiMap.set(k, v);
  } catch (_) {}
  return _ouiMap;
}

// Extract 6-char uppercase OUI from a MAC in any common format
// e.g.  "28:6f:b9:aa:bb:cc" → "286FB9"
function macToOui(mac) {
  if (!mac) return null;
  return mac.replace(/[:\-\.]/g, '').substring(0, 6).toUpperCase();
}

function lookupVendor(mac) {
  const oui = macToOui(mac);
  if (!oui) return null;
  return getOuiMap().get(oui) || null;
}

// ---- Category classification ----

// Rules are checked in priority order (most specific first).
// A vendor string that matches the first applicable rule wins.
const RULES = [
  { cat: 'VMs',      re: /vmware|virtualbox|qemu|xensource|parallels|microsoft.*hv|hyper.?v|red\s*hat.*virt/i },

  { cat: 'Medical',  re: /ge.?health|philips.?med|philips.?health|draeger|mindray|spacelabs|nihon\s*kohden|welch\s*allyn|natus\s*med|biotelemetry|masimo|covidien|carefusion|datascope|siemens.*health|olympus.*med|stryker|fresenius|smiths.?med|criticare|criticare\s*sys|schiller|biomedical|nellcor|spacelabs\s*med/i },

  { cat: 'Cameras',  re: /axis\s*comm|hikvision|dahua|hanwha|pelco|uniview|vivotek|avigilon|arecont|mobotix|geovision|messoa|tiandy|reolink|bosch.?sec|samsung.?techwin|flir\s*sys|canon.?security/i },

  { cat: 'Printers', re: /xerox|lexmark|brother\s*ind|epson|ricoh|konica.?minolta|kyocera|printronix|toshiba.?tec|sharp\s*corp|canon.*print|datacard|zebra\s*tech/i },

  { cat: 'APs',      re: /ruckus|aerohive|meru\s*net|xirrus|ubiquiti|engenius|cambium|mikrotik|aruba\s*net|aeroscout|cisco.?airo/i },

  { cat: 'Network',  re: /juniper\s*net|palo\s*alto\s*net|fortinet|extreme\s*net|brocade|arista\s*net|avocent|cisco\s*sys|check\s*point|apc\s*by\s*schneider|eaton\s*elec|vertiv|zyxel|allied\s*telesis|netscout|f5\s*net/i },

  { cat: 'Computers',re: /apple\s*inc|apple,|dell\s*inc|lenovo|acer\s*inc|asus|toshiba|samsung\s*electron|lg\s*electron|panasonic|fujitsu|nec\s*corp|msi\s*co|intel\s*corp|hewlett.?packard|hp\s*inc|microsoft\s*corp|amazon\s*tech|google\s*llc|wistron|compal|pegatron|quanta\s*comp/i },
];

function classify(vendor) {
  if (!vendor) return 'Unknown';
  for (const { cat, re } of RULES) {
    if (re.test(vendor)) return cat;
  }
  return 'Unknown';
}

// Access threshold: ports with ≤ this many MACs are considered edge ports (not uplinks)
const ACCESS_MAX_MACS = 8;

// Build the is_uplink subquery (same logic as devices.js / search.js)
const IS_UPLINK_SQL = `
  CASE
    WHEN me.phys_if_index IS NULL THEN 0
    WHEN (
      SELECT COUNT(DISTINCT m2.mac_address)
      FROM mac_entries m2
      WHERE m2.device_id = me.device_id AND m2.phys_if_index = me.phys_if_index
    ) > ${ACCESS_MAX_MACS} THEN 1
    ELSE 0
  END
`;

// ---- GET /api/inventory — summary counts per category ----

router.get('/', requireAuth, (req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      me.mac_address,
      me.ip_address,
      me.last_seen,
      d.name  AS device_name,
      d.ip    AS device_ip,
      p.if_name,
      p.if_alias,
      hc.hostname,
      ${IS_UPLINK_SQL} AS is_uplink
    FROM mac_entries me
    JOIN devices d ON d.id = me.device_id
    LEFT JOIN ports p
      ON p.device_id = me.device_id AND p.if_index = me.phys_if_index
    LEFT JOIN hostname_cache hc ON hc.ip_address = me.ip_address
    WHERE me.phys_if_index IS NOT NULL
    ORDER BY me.last_seen DESC
  `).all();

  const counts = {};
  for (const r of rows) {
    if (r.is_uplink) continue;
    const vendor = lookupVendor(r.mac_address);
    const cat    = classify(vendor);
    counts[cat]  = (counts[cat] || 0) + 1;
  }

  const total    = Object.values(counts).reduce((s, n) => s + n, 0);
  const cats     = ['Computers', 'Printers', 'APs', 'Cameras', 'Medical', 'Network', 'VMs', 'Unknown'];
  const categories = cats.map(name => ({ name, count: counts[name] || 0 }));

  res.json({ categories, total });
});

// ---- GET /api/inventory/entries?category=&search=&page=1&limit=100 ----

router.get('/entries', requireAuth, (req, res) => {
  const db   = getDb();
  const cat  = req.query.category || '';
  const q    = (req.query.search  || '').toLowerCase().trim();
  const page = Math.max(1, parseInt(req.query.page  || '1'));
  const lim  = Math.min(200, Math.max(1, parseInt(req.query.limit || '100')));

  const rows = db.prepare(`
    SELECT
      me.mac_address,
      me.ip_address,
      me.last_seen,
      me.device_id,
      d.name  AS device_name,
      d.ip    AS device_ip,
      p.if_name,
      p.if_alias,
      hc.hostname,
      ${IS_UPLINK_SQL} AS is_uplink
    FROM mac_entries me
    JOIN devices d ON d.id = me.device_id
    LEFT JOIN ports p
      ON p.device_id = me.device_id AND p.if_index = me.phys_if_index
    LEFT JOIN hostname_cache hc ON hc.ip_address = me.ip_address
    WHERE me.phys_if_index IS NOT NULL
    ORDER BY me.last_seen DESC
  `).all();

  // Enrich with vendor + category, filter uplinks
  let enriched = [];
  for (const r of rows) {
    if (r.is_uplink) continue;
    const vendor   = lookupVendor(r.mac_address);
    const category = classify(vendor);
    enriched.push({ ...r, vendor: vendor || '', category });
  }

  // Apply category filter
  if (cat && cat !== 'All') {
    enriched = enriched.filter(r => r.category === cat);
  }

  // Apply search filter
  if (q) {
    enriched = enriched.filter(r =>
      (r.mac_address || '').toLowerCase().includes(q) ||
      (r.ip_address  || '').toLowerCase().includes(q) ||
      (r.hostname    || '').toLowerCase().includes(q) ||
      (r.vendor      || '').toLowerCase().includes(q) ||
      (r.device_name || '').toLowerCase().includes(q) ||
      (r.device_ip   || '').toLowerCase().includes(q)
    );
  }

  const total = enriched.length;
  const slice = enriched.slice((page - 1) * lim, page * lim);

  res.json({ rows: slice, total, page, limit: lim });
});

module.exports = router;
