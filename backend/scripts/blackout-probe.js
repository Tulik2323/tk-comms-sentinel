// scripts/blackout-probe.js — בודק אוטונומי לניתוק אינטרנט
//
// מטרה: להפריד בין "הרשת לסוויצ'ים נפלה" לבין "NetMonitor הפסיק לסרוק".
// רץ ללא תלות בשום שירות חיצוני, ורושם כל מחזור לדיסק מיד.
//
// שימוש:
//   node scripts/blackout-probe.js                 (ברירת מחדל: כל 15 שניות)
//   node scripts/blackout-probe.js 10              (כל 10 שניות)
//
// עצירה: Ctrl+C, או סגירת החלון.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs      = require('fs');
const path    = require('path');
const dns     = require('dns');
const net     = require('net');
const snmp    = require('net-snmp');
const { execFile } = require('child_process');
const { initDb, getDb } = require('../db/database');

const INTERVAL_SEC = parseInt(process.argv[2] || '15', 10);
const OUT = path.join(__dirname, '..', 'logs', 'blackout-probe.log');

const GATEWAY   = '172.19.254.254';   // ברירת המחדל אל הסוויצ'ים
const SMTP_HOST = '172.19.19.10';     // שרת הדואר הפנימי
const DNS_PROBE = 'www.microsoft.com'; // שם חיצוני — מזהה מתי האינטרנט נופל

const SYSNAME = '1.3.6.1.2.1.1.5.0';

function line(s) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const txt = `${stamp} | ${s}\n`;
  fs.appendFileSync(OUT, txt, 'utf8');
  process.stdout.write(txt);
}

// --- ping ---
function ping(ip) {
  return new Promise((res) => {
    const t0 = Date.now();
    execFile('ping', ['-n', '1', '-w', '2000', ip], { windowsHide: true }, (err, stdout) => {
      const ok = !err && /TTL=/i.test(stdout || '');
      res({ ok, ms: Date.now() - t0 });
    });
  });
}

// --- TCP connect ---
function tcp(host, port, timeout = 3000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; try { s.destroy(); } catch {} res({ ok, ms: Date.now() - t0 }); } };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error',   () => fin(false));
    s.connect(port, host);
  });
}

// --- DNS: כמה זמן לוקח לפתור שם חיצוני ---
function dnsProbe(name, timeout = 8000) {
  return new Promise((res) => {
    const t0 = Date.now();
    let done = false;
    const fin = (ok, note) => { if (!done) { done = true; res({ ok, ms: Date.now() - t0, note }); } };
    const timer = setTimeout(() => fin(false, 'HANG'), timeout);
    dns.resolve4(name, (err) => {
      clearTimeout(timer);
      fin(!err, err ? err.code : 'ok');
    });
  });
}

// --- SNMP ישיר, עוקף את NetMonitor לגמרי ---
function snmpDirect(ip, community) {
  return new Promise((res) => {
    const t0 = Date.now();
    const s = snmp.createSession(ip, community, { timeout: 4000, retries: 0, version: snmp.Version2c });
    let done = false;
    const fin = (ok, note) => { if (!done) { done = true; try { s.close(); } catch {} res({ ok, ms: Date.now() - t0, note }); } };
    const timer = setTimeout(() => fin(false, 'timeout'), 6000);
    try {
      s.get([SYSNAME], (err, vb) => {
        clearTimeout(timer);
        if (err) return fin(false, err.message.slice(0, 20));
        if (!vb || snmp.isVarbindError(vb[0])) return fin(false, 'varbind');
        fin(true, String(vb[0].value).slice(0, 14));
      });
    } catch (e) { clearTimeout(timer); fin(false, e.message.slice(0, 20)); }
  });
}

// ============================================================
(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const db = await initDb();

  // בוחר עד 3 מכשירים לדגימה ישירה
  const sample = db.prepare(`
    SELECT ip, community FROM devices
    WHERE snmp_version = 'v2c' AND community IS NOT NULL
    ORDER BY id LIMIT 3
  `).all();

  line('='.repeat(78));
  line(`בודק ניתוק הופעל — כל ${INTERVAL_SEC} שניות | PID ${process.pid}`);
  line(`מכשירים לדגימה ישירה: ${sample.map(d => d.ip).join(', ') || '(אין)'}`);
  line(`שער: ${GATEWAY} | SMTP: ${SMTP_HOST} | DNS probe: ${DNS_PROBE}`);
  line('עמודות: GW=שער DNS=פתרון-חיצוני SMTP=חיבור SNMPx=בדיקה-ישירה NM=מה-NetMonitor-חושב');
  line('='.repeat(78));

  async function cycle() {
    const [gw, dnsR, smtpR] = await Promise.all([
      ping(GATEWAY),
      dnsProbe(DNS_PROBE),
      tcp(SMTP_HOST, 25),
    ]);

    // ICMP *וגם* SNMP לכל מכשיר נדגם.
    // בלי ה-ping אי אפשר להבחין בין "הנתיב נפל" לבין "UDP/161 נחסם" —
    // פער שהתגלה בניתוח הניסוי הראשון.
    const direct = [];
    for (const d of sample) {
      const [icmp, sn] = await Promise.all([ping(d.ip), snmpDirect(d.ip, d.community)]);
      direct.push({ ip: d.ip, icmp, snmp: sn });
    }

    // מה NetMonitor עצמו חושב — נקרא מה-DB, לא דרך ה-API
    let nm = 'n/a';
    try {
      const rows = db.prepare('SELECT status, COUNT(*) n FROM devices GROUP BY status').all();
      const m = Object.fromEntries(rows.map(r => [r.status, r.n]));
      const fresh = db.prepare('SELECT COUNT(*) n FROM metrics WHERE ts > unixepoch() - 180').get().n;
      nm = `up=${m.up || 0} down=${m.down || 0} metrics3m=${fresh}`;
    } catch (e) { nm = 'DBERR:' + e.message.slice(0, 20); }

    const f = (r) => `${r.ok ? 'OK' : 'FAIL'}/${r.ms}ms`;
    // לכל מכשיר: PING/SNMP זה לצד זה, כך שההבדל ביניהם קופץ לעין
    const dstr = direct.map((d, i) =>
      `D${i + 1}[ping=${d.icmp.ok ? 'OK' : 'FAIL'} snmp=${d.snmp.ok ? 'OK' : 'FAIL'}/${d.snmp.ms}ms]`
    ).join(' ');

    line(`GW=${f(gw)}  DNS=${dnsR.ok ? 'OK' : dnsR.note}/${dnsR.ms}ms  SMTP=${f(smtpR)}  ${dstr}  NM[${nm}]`);
  }

  await cycle();
  setInterval(() => { cycle().catch(e => line('שגיאת מחזור: ' + e.message)); }, INTERVAL_SEC * 1000);
})();
