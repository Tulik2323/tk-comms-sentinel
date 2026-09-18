// routes/inventory.js — Inventory: OUI-based endpoint classification
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit }    = require('../db/audit');
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

// Categories a VLAN may assign. Unknown is excluded: assigning it would be a no-op.
const CATEGORIES      = ['Computers', 'Printers', 'APs', 'Cameras', 'Medical', 'Network', 'VMs', 'Unknown'];
const VLAN_CATEGORIES = CATEGORIES.filter(c => c !== 'Unknown');

// ---- Custom categories ----
// User-defined categories live in inv_categories and are referenced everywhere as the
// key 'custom_<id>', so they never collide with the built-in names above.

const CUSTOM_ICONS = [
  '🩻', '❤️', '🏥', '🔬', '🧪', '💊', '🩺', '🧬',
  '🖥️', '⚙️', '🏭', '🔌', '📞', '📺', '🎛️', '🗄️',
  '🔒', '🚪', '💡', '🧊', '📦', '🔧', '🛰️', '📟',
];
const CUSTOM_COLORS   = ['#ec4899', '#14b8a6', '#f97316', '#84cc16', '#a855f7', '#0ea5e9', '#eab308', '#f43f5e'];
const CUSTOM_MAX      = 30;
const CUSTOM_NAME_MAX = 32;

const customKey = id => `custom_${id}`;

function loadCustomCategories(db) {
  return db.prepare(`SELECT id, name, icon FROM inv_categories ORDER BY id`).all().map(r => ({
    key:   customKey(r.id),
    id:    r.id,
    label: r.name,
    icon:  r.icon,
    color: CUSTOM_COLORS[r.id % CUSTOM_COLORS.length],
    custom: true,
  }));
}

// Validates an admin-supplied category: '' (none), a built-in, or an existing custom one.
function isAssignableCategory(db, category) {
  if (!category) return true;
  if (VLAN_CATEGORIES.includes(category)) return true;
  return loadCustomCategories(db).some(c => c.key === category);
}

function cleanCategoryInput(body) {
  const name = String((body && body.name) || '').replace(/\s+/g, ' ').trim();
  const icon = String((body && body.icon) || '');
  if (!name) return { error: 'Name is required' };
  if (name.length > CUSTOM_NAME_MAX) return { error: `Name is limited to ${CUSTOM_NAME_MAX} characters` };
  if (!CUSTOM_ICONS.includes(icon)) return { error: 'Choose an icon from the list' };
  return { name, icon };
}

function categoryNameTaken(db, name, exceptId) {
  const lower = name.toLowerCase();
  if (CATEGORIES.some(c => c.toLowerCase() === lower)) return true;
  return loadCustomCategories(db).some(c => c.id !== exceptId && c.label.toLowerCase() === lower);
}

// ---- VLAN detection ----

function validVlan(n) {
  return Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null;
}

// Routers name their L3 VLAN interfaces differently per vendor: "VLAN300" (Aruba/
// ProCurve), "Vlan-interface1" (H3C/HPE Comware), "DEFAULT_VLAN" (ProCurve VLAN 1),
// and "bond100.60" / "irb.220" (a sub-interface tagged with the VLAN).
function vlanFromIfName(name) {
  if (!name) return null;
  let m = name.match(/vlan[-_ ]?(?:interface)?[-_ ]?(\d{1,4})\b/i);
  if (m) return validVlan(+m[1]);
  if (/^default_vlan$/i.test(name)) return 1;
  m = name.match(/\.(\d{1,4})$/);
  if (m) return validVlan(+m[1]);
  return null;
}

// device_id:if_index → { pvid, ifVlan }. pvid is the access VLAN of a switch port;
// ifVlan is the VLAN an L3 interface (where ARP entries are learned) belongs to.
function buildPortVlanMap(db) {
  const rows = db.prepare(`SELECT device_id, if_index, if_name, pvid FROM ports`).all();
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.device_id}:${r.if_index}`, {
      pvid:   validVlan(r.pvid),
      ifVlan: vlanFromIfName(r.if_name),
    });
  }
  return map;
}

function loadVlanNames(db) {
  const rows = db.prepare(`SELECT vlan_id, name, category, force FROM vlan_names`).all();
  return new Map(rows.map(r => [r.vlan_id, {
    name: r.name || '', category: r.category || '', force: r.force ? 1 : 0,
  }]));
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
// The ARP row also tells which L3 interface the address was learned on, which gives
// the VLAN the device actually lives in.
function buildMacIpMap(db, portVlans) {
  const rows = db.prepare(`
    SELECT mac_address, ip_address, last_seen, device_id, if_index
    FROM mac_entries
    WHERE ip_address IS NOT NULL AND ip_address != ''
  `).all();

  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r.mac_address);
    // A MAC can hold several IPs over time (DHCP); keep the most recent.
    if (!prev || r.last_seen > prev.seen) {
      const port = portVlans.get(`${r.device_id}:${r.if_index}`);
      map.set(r.mac_address, { ip: r.ip_address, seen: r.last_seen, vlan: port ? port.ifVlan : null });
    }
  }
  return map;
}

function buildHostnameMap(db) {
  const rows = db.prepare(`SELECT ip, hostname FROM hostname_cache`).all();
  return new Map(rows.map(r => [r.ip, r.hostname]));
}

// Loads the inventory row set and attaches address, hostname, vendor, VLAN and category.
function loadInventory(db) {
  const rows = db.prepare(`${BASE_CTE}
    SELECT
      me.mac_address,
      me.ip_address,
      me.last_seen,
      me.device_id,
      me.if_index,
      me.phys_if_index,
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

  const portVlans = buildPortVlanMap(db);
  const macIp     = buildMacIpMap(db, portVlans);
  const hostnames = buildHostnameMap(db);
  const vlanNames = loadVlanNames(db);

  const resolved = rows.map(({ if_index, phys_if_index, ...r }) => {
    const known    = macIp.get(r.mac_address);
    const ip       = r.ip_address || (known ? known.ip : null);
    const hostname = ip ? (hostnames.get(ip) || null) : null;

    // Prefer the L3 (ARP) VLAN over the port's access VLAN: an IP phone sits on the
    // voice VLAN while its port's PVID is the data VLAN behind it.
    const ownArp  = r.ip_address && if_index != null ? portVlans.get(`${r.device_id}:${if_index}`) : null;
    const phys    = phys_if_index != null ? portVlans.get(`${r.device_id}:${phys_if_index}`) : null;
    const vlan    = (ownArp && ownArp.ifVlan) || (known && known.vlan) || (phys && phys.pvid) || null;
    const vlanRec = vlan ? vlanNames.get(vlan) : null;

    return {
      ...r,
      ip_address: ip,
      hostname,
      vendor:    lookupVendor(r.mac_address) || '',
      vlan,
      vlan_name: vlanRec ? vlanRec.name : '',
    };
  });

  const custom    = new Map(loadCustomCategories(db).map(c => [c.key, c]));
  const validCat  = c => VLAN_CATEGORIES.includes(c) || custom.has(c);

  const apSubnets = findApSubnets(resolved);
  for (const r of resolved) {
    const auto = classify(r.vendor, r.hostname, r.mac_address, r.ip_address, apSubnets);
    const rec  = r.vlan ? vlanNames.get(r.vlan) : null;

    // A VLAN's category fills in devices that OUI/hostname left as Unknown. With the
    // per-VLAN "force" flag it also overrides devices that were already identified.
    const vlanCat = rec && rec.category && validCat(rec.category) && (auto === 'Unknown' || rec.force)
      ? rec.category : '';

    r.auto_category   = auto;
    r.category        = vlanCat || auto;
    r.category_source = vlanCat ? 'vlan' : 'auto';

    const c = custom.get(r.category);
    if (c) r.category_meta = { label: c.label, icon: c.icon, color: c.color };
  }
  return resolved;
}

// ---- GET /api/inventory — summary counts per category ----

router.get('/', requireAuth, (req, res) => {
  const rows = loadInventory(getDb());

  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;

  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  // Built-ins first, then the user's own, with Unknown always last.
  const builtin = CATEGORIES.filter(c => c !== 'Unknown').map(name => ({ name, count: counts[name] || 0 }));
  const custom  = loadCustomCategories(getDb()).map(c => ({
    name: c.key, label: c.label, icon: c.icon, color: c.color, custom: true, count: counts[c.key] || 0,
  }));
  const categories = [...builtin, ...custom, { name: 'Unknown', count: counts.Unknown || 0 }];

  res.json({ categories, total });
});

// ---- Custom categories — admin only to change ----

router.get('/categories', requireAuth, (req, res) => {
  res.json({ categories: loadCustomCategories(getDb()), icons: CUSTOM_ICONS });
});

router.post('/categories', requireAdmin, (req, res) => {
  const db = getDb();
  const c  = cleanCategoryInput(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  if (db.prepare(`SELECT COUNT(*) n FROM inv_categories`).get().n >= CUSTOM_MAX) {
    return res.status(400).json({ error: `At most ${CUSTOM_MAX} custom categories` });
  }
  if (categoryNameTaken(db, c.name, null)) return res.status(409).json({ error: 'A category with this name already exists' });

  const info = db.prepare(`INSERT INTO inv_categories (name, icon) VALUES (?, ?)`).run(c.name, c.icon);
  logAudit('info', 'admin', 'inv_category_created', { name: c.name }, { username: req.user && req.user.username, ip: req.ip });

  const created = loadCustomCategories(db).find(x => x.id === Number(info.lastInsertRowid));
  res.status(201).json(created);
});

router.put('/categories/:id', requireAdmin, (req, res) => {
  const db  = getDb();
  const id  = Number(req.params.id);
  const cur = Number.isInteger(id) ? db.prepare(`SELECT name FROM inv_categories WHERE id = ?`).get(id) : null;
  if (!cur) return res.status(404).json({ error: 'No such category' });

  const c = cleanCategoryInput(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  if (categoryNameTaken(db, c.name, id)) return res.status(409).json({ error: 'A category with this name already exists' });

  db.prepare(`UPDATE inv_categories SET name = ?, icon = ? WHERE id = ?`).run(c.name, c.icon, id);
  logAudit('info', 'admin', 'inv_category_updated', { old: cur.name, name: c.name }, { username: req.user && req.user.username, ip: req.ip });
  res.json(loadCustomCategories(db).find(x => x.id === id));
});

// Deleting releases every VLAN that used the category; those devices fall back to
// their own automatic classification (Unknown when nothing else identified them).
router.delete('/categories/:id', requireAdmin, (req, res) => {
  const db  = getDb();
  const id  = Number(req.params.id);
  const cur = Number.isInteger(id) ? db.prepare(`SELECT name FROM inv_categories WHERE id = ?`).get(id) : null;
  if (!cur) return res.status(404).json({ error: 'No such category' });

  const released = db.prepare(`UPDATE vlan_names SET category = NULL, force = 0 WHERE category = ?`).run(customKey(id)).changes;
  db.prepare(`DELETE FROM vlan_names WHERE (name IS NULL OR name = '') AND category IS NULL`).run();
  db.prepare(`DELETE FROM inv_categories WHERE id = ?`).run(id);

  logAudit('info', 'admin', 'inv_category_deleted', { name: cur.name, vlans: released }, { username: req.user && req.user.username, ip: req.ip });
  res.json({ deleted: id, vlans_released: released });
});

// ---- GET /api/inventory/vlans — detected VLANs with their user-given names ----

router.get('/vlans', requireAuth, (req, res) => {
  const db    = getDb();
  const rows  = loadInventory(db);
  const names = loadVlanNames(db);

  const stats = new Map();
  const statOf = vlan => {
    if (!stats.has(vlan)) stats.set(vlan, { endpoints: 0, unknown: 0, ports: 0, switches: new Set() });
    return stats.get(vlan);
  };

  for (const r of rows) {
    if (!r.vlan) continue;
    const s = statOf(r.vlan);
    s.endpoints++;
    if (r.auto_category === 'Unknown') s.unknown++;
  }

  const ports = db.prepare(`SELECT device_id, pvid FROM ports WHERE pvid IS NOT NULL`).all();
  for (const p of ports) {
    const vlan = validVlan(p.pvid);
    if (!vlan) continue;
    const s = statOf(vlan);
    s.ports++;
    s.switches.add(p.device_id);
  }

  // Keep named VLANs listed even when nothing is currently seen on them.
  for (const vlan of names.keys()) statOf(vlan);

  const vlans = [...stats.entries()].map(([vlan_id, s]) => {
    const n = names.get(vlan_id) || { name: '', category: '', force: 0 };
    return {
      vlan_id,
      name:      n.name,
      category:  n.category,
      force:     n.force,
      endpoints: s.endpoints,
      unknown:   s.unknown,
      ports:     s.ports,
      switches:  s.switches.size,
    };
  }).sort((a, b) => b.endpoints - a.endpoints || b.ports - a.ports || a.vlan_id - b.vlan_id);

  const categories = [
    ...VLAN_CATEGORIES.map(key => ({ key, custom: false })),
    ...loadCustomCategories(db),
  ];
  res.json({ vlans, categories, icons: CUSTOM_ICONS });
});

// ---- PUT /api/inventory/vlans/:id  { name, category, force } — admin only ----

router.put('/vlans/:id', requireAdmin, (req, res) => {
  const vlan = validVlan(Number(req.params.id));
  if (!vlan) return res.status(400).json({ error: 'VLAN must be 1-4094' });

  const db       = getDb();
  const name     = String((req.body && req.body.name) || '').trim().slice(0, 64);
  const category = String((req.body && req.body.category) || '').trim();
  if (!isAssignableCategory(db, category)) {
    return res.status(400).json({ error: `Unknown category: ${category}` });
  }
  // "Force" only means something when there is a category to force.
  const force = category && req.body && req.body.force ? 1 : 0;

  const audit = { username: req.user && req.user.username, ip: req.ip };

  if (!name && !category) {
    db.prepare(`DELETE FROM vlan_names WHERE vlan_id = ?`).run(vlan);
    logAudit('info', 'admin', 'vlan_name_cleared', { vlan }, audit);
  } else {
    db.prepare(`
      INSERT INTO vlan_names (vlan_id, name, category, force, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(vlan_id) DO UPDATE SET
        name = excluded.name, category = excluded.category,
        force = excluded.force, updated_at = excluded.updated_at
    `).run(vlan, name, category || null, force);
    logAudit('info', 'admin', 'vlan_name_updated', { vlan, name, category, force }, audit);
  }

  res.json({ vlan_id: vlan, name, category, force });
});

// ---- GET /api/inventory/entries?category=&vlan=&search=&page=1&limit=100 ----

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

  const vlan = validVlan(Number(req.query.vlan));
  if (vlan) {
    enriched = enriched.filter(r => r.vlan === vlan);
  }

  if (q) {
    enriched = enriched.filter(r =>
      (r.vlan_name   || '').toLowerCase().includes(q) ||
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
