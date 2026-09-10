// routes/tools.js — כלי אבחון תקשורת מהשרת אל יעד נתון
const express = require('express');
const router  = express.Router();
const net     = require('net');
const dns     = require('dns');
const { execFile } = require('child_process');
const snmp    = require('net-snmp');

const { requireAdmin } = require('../middleware/auth');
const { getSetting }   = require('../db/database');
const { logAudit }     = require('../db/audit');

// ---- אימות קלט ----
// רק IPv4 או שם מארח תקין. חוסם הזרקת ארגומנטים ל-ping ומונע
// שימוש בנקודת הקצה כמנוע סריקה כללי.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function validTarget(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (!s || s.length > 253) return false;
  return IPV4.test(s) || HOST.test(s);
}

// ---- ICMP ----
function pingHost(target) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('ping', ['-n', '3', '-w', '1500', target], { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        const out = stdout || '';
        const ok  = /TTL=/i.test(out);
        // אחוז אובדן ומזמן ממוצע, אם ping דיווח עליהם
        const loss = out.match(/(\d+)%\s*loss|אבדו\s*\((\d+)%/i);
        const avg  = out.match(/Average\s*=\s*(\d+)ms|ממוצע\s*=\s*(\d+)ms/i);
        resolve({
          ok,
          ms: Date.now() - t0,
          loss: loss ? parseInt(loss[1] || loss[2]) : (ok ? 0 : 100),
          avgMs: avg ? parseInt(avg[1] || avg[2]) : null,
          detail: ok ? null : 'אין תגובה ל-ICMP (ייתכן שחסום ולא שהמכשיר כבוי)',
        });
      });
  });
}

// ---- TCP ----
function tcpProbe(target, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = new net.Socket();
    let settled = false;
    const fin = (ok, detail, banner) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch {}
      resolve({ port, ok, ms: Date.now() - t0, detail, banner });
    };
    s.setTimeout(timeout);
    s.once('connect', () => {
      // חלק מהשירותים (SSH) שולחים באנר מיד — שימושי לזיהוי
      let banner = '';
      s.once('data', (d) => { banner = d.toString('utf8').split('\n')[0].trim().slice(0, 60); fin(true, null, banner); });
      setTimeout(() => fin(true, null, banner || null), 600);
    });
    s.once('timeout', () => fin(false, 'timeout'));
    s.once('error',   (e) => fin(false, e.code || e.message));
    s.connect(port, target);
  });
}

// ---- SNMP ----
function snmpProbe(target, community, version) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ver = version === 'v1' ? snmp.Version1 : snmp.Version2c;
    let session;
    let settled = false;
    const fin = (ok, detail, data) => {
      if (settled) return;
      settled = true;
      try { session && session.close(); } catch {}
      resolve({ ok, ms: Date.now() - t0, detail, ...data });
    };
    try {
      session = snmp.createSession(target, community, { timeout: 4000, retries: 0, version: ver });
      const timer = setTimeout(() => fin(false, 'timeout'), 6000);
      session.get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0'], (err, vb) => {
        clearTimeout(timer);
        if (err) return fin(false, err.message);
        if (!vb || snmp.isVarbindError(vb[0])) return fin(false, 'תשובה לא תקינה');
        fin(true, null, {
          sysName:  String(vb[0].value),
          sysDescr: String(vb[1].value).replace(/\s+/g, ' ').trim().slice(0, 160),
          uptimeSec: vb[2] && !snmp.isVarbindError(vb[2]) ? Math.floor(Number(vb[2].value) / 100) : null,
        });
      });
    } catch (e) { fin(false, e.message); }
  });
}

// ---- כיול מול יירוט שקוף ----
// ברשתות עם proxy/FW מסנן, פורטים כמו 80 ו-443 עונים לכל יעד — גם לכתובת
// שאין בה דבר. בלי כיול, "פורט פתוח" הוא ממצא חסר ערך ומטעה.
// נמדד ברשת הזו: 80 ו-443 נענים עבור כל כתובת.
const CONTROL_IP = '192.0.2.1';          // RFC 5737 — שמור לתיעוד, לעולם לא מנותב
const CAL_TTL_MS = 5 * 60 * 1000;
let _calCache = { at: 0, ports: {} };

async function calibrate(portList) {
  const missing = portList.filter(p => !(p in _calCache.ports));
  if (Date.now() - _calCache.at > CAL_TTL_MS) { _calCache = { at: 0, ports: {} }; }
  const need = Date.now() - _calCache.at > CAL_TTL_MS ? portList : missing;

  if (need.length) {
    const results = await Promise.all(need.map(p => tcpProbe(CONTROL_IP, p, 3000)));
    need.forEach((p, i) => { _calCache.ports[p] = results[i].ok; });
    _calCache.at = Date.now();
  }
  return _calCache.ports;
}

// ---- DNS ----
function resolveTarget(target) {
  return new Promise((resolve) => {
    if (IPV4.test(target)) return resolve({ ok: true, ms: 0, addresses: [target], skipped: true });
    const t0 = Date.now();
    dns.resolve4(target, (err, addrs) => {
      resolve(err
        ? { ok: false, ms: Date.now() - t0, detail: err.code }
        : { ok: true, ms: Date.now() - t0, addresses: addrs });
    });
  });
}

// ============================================================
// POST /api/tools/diagnose  { target, ports?, community?, snmpVersion? }
router.post('/diagnose', requireAdmin, async (req, res) => {
  const { target, ports, community, snmpVersion } = req.body || {};

  if (!validTarget(target)) {
    return res.status(400).json({ error: 'יעד לא תקין. הזן כתובת IPv4 או שם מארח.' });
  }
  const host = String(target).trim();

  // פורטים לבדיקה: ברירת מחדל SSH / Telnet / HTTP / HTTPS
  let portList = Array.isArray(ports) && ports.length ? ports : [22, 23, 80, 443];
  portList = portList
    .map(p => parseInt(p, 10))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536)
    .slice(0, 12);   // תקרה — לא מנוע סריקה

  const comm = (community && String(community).trim()) || getSetting('default_snmp_community') || process.env.DEFAULT_SNMP_COMMUNITY || 'public';

  logAudit('info', 'admin', `אבחון תקשורת אל ${host}`, { username: req.user.username, ip: req.ip });

  const started = Date.now();
  const [dnsR, icmp, tcpRaw, snmpR, cal] = await Promise.all([
    resolveTarget(host),
    pingHost(host),
    Promise.all(portList.map(p => tcpProbe(host, p))),
    snmpProbe(host, comm, snmpVersion),
    calibrate(portList),
  ]);

  // פורט שנענה גם עבור כתובת הביקורת אינו ראיה לכלום
  const tcp = tcpRaw.map(t => ({ ...t, intercepted: Boolean(cal[t.port] && t.ok) }));
  const trustworthyOpen = tcp.filter(t => t.ok && !t.intercepted);

  // מסקנה קריאה במקום שהמשתמש ירכיב אותה בעצמו
  let verdict;
  if (snmpR.ok)          verdict = { level: 'ok',   text: `המכשיר מגיב ל-SNMP. ניתן להוסיף אותו לניטור.` };
  else if (icmp.ok)      verdict = { level: 'warn', text: `היעד חי ברשת אך אינו מגיב ל-SNMP. בדוק שה-SNMP מופעל, שה-community נכון, ושאין ACL חוסם.` };
  else if (trustworthyOpen.length) verdict = { level: 'warn', text: `ICMP חסום אך פורט ${trustworthyOpen.map(t => t.port).join('/')} פתוח — היעד קיים.` };
  else                   verdict = { level: 'error', text: `אין תגובה בשום פרוטוקול. בדוק ניתוב, חומת אש, או שהכתובת שגויה.` };

  const interceptedPorts = Object.entries(cal).filter(([, v]) => v).map(([p]) => Number(p));

  res.json({
    target: host,
    totalMs: Date.now() - started,
    dns: dnsR,
    icmp,
    tcp,
    snmp: { ...snmpR, community: comm === 'public' ? 'public' : '(מוגדר)', version: snmpVersion || 'v2c' },
    verdict,
    interceptedPorts,
  });
});

module.exports = router;
// מיוצאים לבדיקה ישירה בלי לעקוף את שכבת האימות
module.exports.__probes = { validTarget, pingHost, tcpProbe, snmpProbe, resolveTarget };
