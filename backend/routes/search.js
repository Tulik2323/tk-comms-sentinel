// routes/search.js — חיפוש MAC / IP / שם מכשיר
const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const db   = getDb();
  const like = `%${q}%`;

  // IP מלא (4 אוקטטים) → exact match; חלקי → prefix match
  const isFullIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(q);

  // חיפוש מכשירים לפי IP / שם — exact IP ראשון
  const devices = db.prepare(`
    SELECT id, name, ip, sys_name, status,
           (ip = ?) AS exact_match
    FROM devices
    WHERE ip = ? OR ip LIKE ? OR name LIKE ? OR sys_name LIKE ?
    ORDER BY exact_match DESC
    LIMIT 8
  `).all(q, q, like, like, like).map(d => ({ type: 'device', ...d }));

  // חיפוש endpoint (MAC/IP): מחזיר רק את פורט הקצה האמיתי — הפורט שלמד הכי
  // מעט MAC-ים. MAC של תחנה נלמד גם על כל ה-uplinks לליבה (אלפי MAC) וגם
  // כרשומת ARP על ה-GW; בלי הסינון החיפוש החזיר 5+ שורות רעש במקום המקום
  // האחד האמיתי. אותה לוגיקה כמו /api/devices/endpoint-search.
  const ACCESS_MAX_MACS = 8;
  const macBaseSql = `
    SELECT m.mac_address, m.ip_address, m.device_id, m.phys_if_index, m.if_index, m.last_seen,
           d.name AS device_name, d.ip AS device_ip, d.status AS device_status,
           p.if_name, p.if_descr, p.if_alias,
           CASE WHEN m.phys_if_index IS NULL THEN NULL ELSE (
             SELECT COUNT(DISTINCT m2.mac_address) FROM mac_entries m2
             WHERE m2.device_id = m.device_id AND m2.phys_if_index = m.phys_if_index
           ) END AS macs_on_port,
           CASE WHEN m.phys_if_index IS NULL THEN 0
                WHEN (SELECT COUNT(DISTINCT m2.mac_address) FROM mac_entries m2
                      WHERE m2.device_id = m.device_id AND m2.phys_if_index = m.phys_if_index) > ${ACCESS_MAX_MACS}
                THEN 1 ELSE 0 END AS is_uplink
    FROM mac_entries m
    JOIN devices d ON d.id = m.device_id
    LEFT JOIN ports p ON p.device_id = m.device_id
                     AND p.if_index = COALESCE(m.phys_if_index, m.if_index)
  `;
  // התאמה מדויקת ל-IP קודם (מונע ש-"10.221.43.1" יתפוס גם .10/.13/.14),
  // אחרת substring / MAC.
  let macRows = db.prepare(`${macBaseSql} WHERE m.ip_address = ? LIMIT 60`).all(q);
  if (macRows.length === 0) {
    const macLike = `%${q.replace(/:/g, '')}%`;
    macRows = db.prepare(`${macBaseSql} WHERE m.ip_address LIKE ? OR REPLACE(m.mac_address, ':', '') LIKE ? LIMIT 60`).all(like, macLike);
  }
  // הרחבה לכל הרשומות של אותם MAC-ים — פורט הקצה נושא רק MAC (בלי IP),
  // אז חיפוש לפי IP לבדו לא היה מגיע אליו.
  const macSet = [...new Set(macRows.map(r => r.mac_address).filter(Boolean))];
  if (macSet.length) {
    const ph = macSet.map(() => '?').join(',');
    const extra = db.prepare(`${macBaseSql} WHERE m.mac_address IN (${ph}) LIMIT 60`).all(...macSet);
    const seen = new Set(macRows.map(r => `${r.device_id}:${r.mac_address}:${r.phys_if_index}`));
    for (const r of extra) {
      const k = `${r.device_id}:${r.mac_address}:${r.phys_if_index}`;
      if (!seen.has(k)) { macRows.push(r); seen.add(k); }
    }
  }
  // IP לכל MAC (מרשומות ה-ARP) לצירוף לשורת הקצה שאין לה IP משלה.
  const ipByMac = {};
  for (const r of macRows) if (r.ip_address && r.mac_address && !ipByMac[r.mac_address]) ipByMac[r.mac_address] = r.ip_address;
  // רק פורטי קצה אמיתיים, ממוינים לפי מספר MAC עולה. אם אין — fallback לכל מה שיש.
  let access = macRows
    .filter(r => r.phys_if_index != null && !r.is_uplink)
    .map(r => ({ ...r, ip_address: r.ip_address || ipByMac[r.mac_address] || null }))
    .sort((a, b) => (a.macs_on_port ?? Infinity) - (b.macs_on_port ?? Infinity) || b.last_seen - a.last_seen);
  if (access.length === 0) access = macRows.slice(0, 10);
  const macs = access.slice(0, 10).map(m => ({ type: 'mac', ...m }));

  res.json([...devices, ...macs]);
});

module.exports = router;
