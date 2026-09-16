// services/hostnames.js — reverse DNS (PTR) עבור כתובות IP שנצפו ב-mac_entries.
// המטרה: להראות שם מחשב לצד IP בכל מקום שמציג endpoints, בהנחה שה-DHCP
// רושם dynamic DNS updates (ברירת מחדל נפוצה בסביבת AD).
const dns = require('dns');
const { getDb } = require('../db/database');

const TTL_SEC        = 6 * 3600;  // כמה זמן תוצאה (כולל "לא נמצא") נחשבת טרייה
const LOOKUP_TIMEOUT  = 1500;     // ms — לא לתקוע את הבדיקה אם ה-DNS לא עונה
const BATCH_SIZE      = 40;       // כמה IPים לרענן בכל סבב cron
const CONCURRENCY     = 8;        // בדיקות מקבילות בכל סבב

function reverseLookup(ip) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, LOOKUP_TIMEOUT);
    dns.reverse(ip, (err, hostnames) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(!err && hostnames && hostnames.length ? hostnames[0] : null);
    });
  });
}

// מרענן batch של IPים שאין להם תרגום טרי ב-hostname_cache.
// נקרא מ-cron תקופתי (services/poller.js) — לא בנתיב הבקשה, כדי שדפי
// ה-UI תמיד יקראו מהמטמון בלבד ולא ימתינו ל-DNS.
async function refreshStaleHostnames() {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - TTL_SEC;

  const candidates = db.prepare(`
    SELECT DISTINCT ip_address AS ip
    FROM mac_entries
    WHERE ip_address IS NOT NULL AND ip_address != ''
      AND ip_address NOT IN (
        SELECT ip FROM hostname_cache WHERE resolved_at > ?
      )
    LIMIT ?
  `).all(cutoff, BATCH_SIZE);

  if (candidates.length === 0) return;

  const upsert = db.prepare(`
    INSERT INTO hostname_cache (ip, hostname, resolved_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(ip) DO UPDATE SET hostname = excluded.hostname, resolved_at = excluded.resolved_at
  `);

  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const { ip } = candidates[idx++];
      try {
        const hostname = await reverseLookup(ip);
        upsert.run(ip, hostname);
      } catch (_) { /* השאר לא פתור — ינוסה שוב בסבב הבא */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
}

// מצרף hostname לכל שורה עם ip_address, מתוך המטמון בלבד (סינכרוני, מהיר).
function attachHostnames(rows) {
  const ips = [...new Set(rows.map(r => r.ip_address).filter(Boolean))];
  if (ips.length === 0) return rows;
  const db = getDb();
  const placeholders = ips.map(() => '?').join(',');
  const found = db.prepare(`SELECT ip, hostname FROM hostname_cache WHERE ip IN (${placeholders})`).all(...ips);
  const map = Object.fromEntries(found.map(r => [r.ip, r.hostname]));
  return rows.map(r => ({ ...r, hostname: r.ip_address ? (map[r.ip_address] || null) : null }));
}

module.exports = { refreshStaleHostnames, attachHostnames };
