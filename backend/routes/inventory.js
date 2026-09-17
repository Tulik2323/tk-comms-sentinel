// routes/inventory.js — Inventory: OUI-based endpoint classification
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const dns  = require('dns');
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
const RULES = [
  { cat: 'VMs',      re: /vmware|virtualbox|qemu|xensource|parallels|microsoft.*hv|hyper.?v|red\s*hat.*virt/i },

  { cat: 'Medical',  re: /ge.?health|philips.?med|philips.?health|draeger|mindray|spacelabs|nihon\s*kohden|welch\s*allyn|natus\s*med|biotelemetry|masimo|covidien|carefusion|datascope|siemens.*health|olympus.*med|stryker|fresenius|smiths.?med|criticare|criticare\s*sys|schiller|biomedical|nellcor|spacelabs\s*med/i },

  { cat: 'Cameras',  re: /axis\s*comm|hikvision|dahua|hanwha|pelco|uniview|vivotek|avigilon|arecont|mobotix|geovision|messoa|tiandy|reolink|bosch.?sec|samsung.?techwin|flir\s*sys|canon.?security/i },

  { cat: 'Printers', re: /xerox|lexmark|brother\s*ind|epson|ricoh|konica.?minolta|kyocera|printronix|toshiba.?tec|sharp\s*corp|canon.*print|datacard|zebra\s*tech/i },

  { cat: 'APs',      re: /ruckus|aerohive|meru\s*net|xirrus|ubiquiti|engenius|cambium|mikrotik|aruba|aeroscout|cisco.?airo/i },

  { cat: 'Network',  re: /juniper\s*net|palo\s*alto\s*net|fortinet|extreme\s*net|brocade|arista\s*net|avocent|cisco\s*sys|check\s*point|apc\s*by\s*schneider|eaton\s*elec|vertiv|zyxel|allied\s*telesis|netscout|f5\s*net/i },

  { cat: 'Computers',re: /apple\s*inc|apple,|dell\s*inc|lenovo|acer\s*inc|asus|toshiba|samsung\s*electron|lg\s*electron|panasonic|fujitsu|nec\s*corp|msi\s*co|intel\s*corp|hewlett.?packard|hp\s*inc|microsoft\s*corp|amazon\s*tech|google\s*llc|wistron|compal|pegatron|quanta\s*comp/i },
];

// Vendors that ship wireless APs but whose OUI string is indistinguishable from
// their server/PC lines — HPE registers Aruba APs and ProLiant servers under the
// same "Hewlett Packard Enterprise" name.
const WIRELESS_VENDOR_RE = /hewlett\s*packard\s*enterprise|aruba/i;

const HOSTNAME_AP_RE    = /\bap[-_\d]|\bwap\b|access.?point|\baruba\b/i;
const HOSTNAME_CAM_RE   = /\bcam\b|\bcamera\b|ipcam|\bnvr\b|\bdvr\b/i;
const HOSTNAME_PRINT_RE = /\bprinter\b|\bprint\b|\bmfp\b|copier/i;

// Aruba APs are named "<Location><sep><last 2 MAC bytes>" here — ec:1b:5f:c2:31:41
// resolves to "TZ_Flr0_Cardio_Eco_31:41". Servers and iLO interfaces never embed
// their own MAC, so this separates HPE access points from HPE ProLiant hosts.
function hostnameCarriesMacTail(mac, hostname) {
  if (!mac || !hostname) return false;
  const hex = mac.replace(/[:\-\.]/g, '').toLowerCase();
  if (hex.length < 12) return false;
  const b5 = hex.substring(8, 10);
  const b6 = hex.substring(10, 12);
  const host = hostname.toLowerCase();
  return [`${b5}:${b6}`, `${b5}-${b6}`, `${b5}_${b6}`, `${b5}${b6}`]
    .some(tail => host.includes(tail));
}

function hostnameLooksLikeAp(mac, hostname) {
  return HOSTNAME_AP_RE.test(hostname) || hostnameCarriesMacTail(mac, hostname);
}

function subnetOf(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
}

const AP_SUBNET_MIN_NAMED = 3;
const AP_SUBNET_MIN_SHARE = 0.9;

// Most APs here have no PTR record, leaving them with a blank hostname — and the OUI
// alone cannot separate an Aruba AP from an HPE ProLiant server. So derive the verdict
// per /24 from the neighbours that DO resolve: APs sit in dedicated subnets, and the
// resolvable members of those subnets are unanimously APs, while server subnets score 0.
function findApSubnets(rows) {
  const stats = new Map();
  for (const r of rows) {
    if (!r.vendor || !WIRELESS_VENDOR_RE.test(r.vendor)) continue;
    if (!r.hostname) continue;
    const sub = subnetOf(r.ip_address);
    if (!sub) continue;
    if (!stats.has(sub)) stats.set(sub, { named: 0, ap: 0 });
    const s = stats.get(sub);
    s.named++;
    if (hostnameLooksLikeAp(r.mac_address, r.hostname)) s.ap++;
  }

  const apSubnets = new Set();
  for (const [sub, s] of stats) {
    if (s.named >= AP_SUBNET_MIN_NAMED && s.ap / s.named >= AP_SUBNET_MIN_SHARE) {
      apSubnets.add(sub);
    }
  }
  return apSubnets;
}

function classify(vendor, hostname, mac, ip, apSubnets) {
  const isWireless = !!vendor && WIRELESS_VENDOR_RE.test(vendor);

  if (hostname) {
    if (HOSTNAME_AP_RE.test(hostname))    return 'APs';
    if (HOSTNAME_CAM_RE.test(hostname))   return 'Cameras';
    if (HOSTNAME_PRINT_RE.test(hostname)) return 'Printers';
    if (isWireless && hostnameCarriesMacTail(mac, hostname)) return 'APs';
  } else if (isWireless && apSubnets.has(subnetOf(ip))) {
    return 'APs';
  }

  if (!vendor) return 'Unknown';
  for (const { cat, re } of RULES) {
    if (re.test(vendor)) return cat;
  }
  return 'Unknown';
}

// Access threshold: ports with > this many MACs are considered uplinks
const ACCESS_MAX_MACS = 8;

// CTE: pre-aggregate uplink ports (port-based entries only)
const BASE_CTE = `
  WITH uplink_ports AS (
    SELECT device_id, phys_if_index
    FROM mac_entries
    WHERE phys_if_index IS NOT NULL
    GROUP BY device_id, phys_if_index
    HAVING COUNT(DISTINCT mac_address) > ${ACCESS_MAX_MACS}
  )
`;

// Keep an entry when it is either a switch-port entry on a non-uplink port, or an
// ARP-learned entry with a known IP. ARP-only rows have no phys_if_index, so the
// uplink test cannot apply to them — they are edge devices by definition.
const ENTRY_FILTER = `
  (
    (me.phys_if_index IS NOT NULL AND up.device_id IS NULL)
    OR
    (me.phys_if_index IS NULL AND me.ip_address IS NOT NULL AND me.ip_address != '')
  )
`;

// ---- Reverse-DNS enrichment ----
// Fills hostname_cache for IPs the poller has not resolved yet. Each IP is attempted
// once per process lifetime: roughly half have no PTR record, and without that guard
// every request would re-queue the same misses forever.

const DNS_CONCURRENCY = 8;
const DNS_TIMEOUT_MS  = 2000;
const DNS_QUEUE_MAX   = 20000;

const _dnsQueue  = new Set();
const _dnsTried  = new Set();
let   _dnsActive = 0;

function enqueueDnsLookup(db, ip) {
  if (!ip || _dnsTried.has(ip) || _dnsQueue.has(ip)) return;
  if (_dnsQueue.size >= DNS_QUEUE_MAX) return;
  _dnsQueue.add(ip);
  pumpDnsQueue(db);
}

function pumpDnsQueue(db) {
  while (_dnsActive < DNS_CONCURRENCY && _dnsQueue.size > 0) {
    const ip = _dnsQueue.values().next().value;
    _dnsQueue.delete(ip);
    _dnsTried.add(ip);
    _dnsActive++;
    resolveOne(db, ip, () => {
      _dnsActive--;
      pumpDnsQueue(db);
    });
  }
}

function resolveOne(db, ip, done) {
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); } };
  const timer = setTimeout(finish, DNS_TIMEOUT_MS);

  dns.reverse(ip, (err, hostnames) => {
    clearTimeout(timer);
    if (!err && hostnames && hostnames.length > 0) {
      try {
        db.prepare(
          `INSERT INTO hostname_cache(ip, hostname, resolved_at)
           VALUES(?,?,strftime('%s','now'))
           ON CONFLICT(ip) DO UPDATE SET hostname=excluded.hostname, resolved_at=excluded.resolved_at`
        ).run(ip, hostnames[0]);
      } catch (_) {}
    }
    finish();
  });
}

// A switch MAC table yields a MAC and a port but no IP, so about a third of the rows
// arrive with no address. The same MAC usually also shows up in a router's ARP table
// carrying its IP, so cross-referencing by MAC recovers it. Doing the aggregation here
// rather than as a SQL GROUP BY is ~5x faster on this table, and it lets the hostname
// be looked up against the recovered address.
function buildMacIpMap(db) {
  const rows = db.prepare(`
    SELECT mac_address, ip_address, last_seen
    FROM mac_entries
    WHERE ip_address IS NOT NULL AND ip_address != ''
  `).all();

  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r.mac_address);
    // A MAC can hold several IPs over time (DHCP); keep the most recent.
    if (!prev || r.last_seen > prev.seen) {
      map.set(r.mac_address, { ip: r.ip_address, seen: r.last_seen });
    }
  }
  return map;
}

function buildHostnameMap(db) {
  const rows = db.prepare(`SELECT ip, hostname FROM hostname_cache`).all();
  return new Map(rows.map(r => [r.ip, r.hostname]));
}

// Loads the inventory row set and attaches address, hostname, vendor and category.
function loadInventory(db) {
  const rows = db.prepare(`${BASE_CTE}
    SELECT
      me.mac_address,
      me.ip_address,
      me.last_seen,
      me.device_id,
      d.name  AS device_name,
      d.ip    AS device_ip,
      p.if_name,
      p.if_alias
    FROM mac_entries me
    JOIN devices d ON d.id = me.device_id
    LEFT JOIN ports p
      ON p.device_id = me.device_id AND p.if_index = me.phys_if_index
    LEFT JOIN uplink_ports up
      ON up.device_id = me.device_id AND up.phys_if_index = me.phys_if_index
    WHERE ${ENTRY_FILTER}
    ORDER BY me.last_seen DESC
  `).all();

  const macIp    = buildMacIpMap(db);
  const hostnames = buildHostnameMap(db);

  const resolved = rows.map(r => {
    const known    = macIp.get(r.mac_address);
    const ip       = r.ip_address || (known ? known.ip : null);
    const hostname = ip ? (hostnames.get(ip) || null) : null;
    return { ...r, ip_address: ip, hostname, vendor: lookupVendor(r.mac_address) || '' };
  });

  const apSubnets = findApSubnets(resolved);
  for (const r of resolved) {
    r.category = classify(r.vendor, r.hostname, r.mac_address, r.ip_address, apSubnets);
  }
  return resolved;
}

// ---- GET /api/inventory — summary counts per category ----

router.get('/', requireAuth, (req, res) => {
  const rows = loadInventory(getDb());

  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;

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

  let enriched = loadInventory(db);

  for (const r of enriched) {
    if (!r.hostname && r.ip_address) enqueueDnsLookup(db, r.ip_address);
  }

  if (cat && cat !== 'All') {
    enriched = enriched.filter(r => r.category === cat);
  }

  if (q) {
    enriched = enriched.filter(r =>
      (r.mac_address || '').toLowerCase().includes(q) ||
      (r.ip_address  || '').toLowerCase().includes(q) ||
      (r.hostname    || '').toLowerCase().includes(q) ||
      (r.vendor      || '').toLowerCase().includes(q) ||
      (r.device_name || '').toLowerCase().includes(q) ||
      (r.device_ip   || '').toLowerCase().includes(q) ||
      (r.if_alias    || '').toLowerCase().includes(q) ||
      (r.if_name     || '').toLowerCase().includes(q)
    );
  }

  const total = enriched.length;
  const slice = enriched.slice((page - 1) * lim, page * lim);

  res.json({ rows: slice, total, page, limit: lim });
});

module.exports = router;
