// services/validate.js — בדיקות קלט משותפות (כתובות IP, טווחי סריקה, טקסט ומספרים)

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isIPv4(s) {
  return typeof s === 'string' && IPV4.test(s.trim());
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc * 256) + parseInt(oct, 10), 0);
}

function longToIp(n) {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
}

// מחרוזת קצרה: ערך לא-מחרוזת נדחה, רווחים נחתכים, ואורך מעל המקסימום נדחה.
// undefined/null מחזירים undefined (השדה לא נשלח).
function cleanText(v, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > max ? null : s;
}

// מספר שלם בטווח, או null. undefined/'' מחזירים undefined (השדה לא נשלח).
function intInRange(v, min, max) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// הרחבת טווח start..end לרשימת כתובות. זורק אם הטווח ריק, הפוך או גדול מ-max —
// לפני שנוצר אפילו מערך אחד (טווח /8 היה בונה 16 מיליון כתובות ומפיל את התהליך).
function expandRange(startIp, endIp, max) {
  if (!isIPv4(startIp) || !isIPv4(endIp)) throw new RangeError('כתובת IP לא תקינה');
  const start = ipToLong(startIp.trim());
  const end   = ipToLong(endIp.trim());
  if (end < start) throw new RangeError('כתובת הסיום קטנה מכתובת ההתחלה');
  if (end - start + 1 > max) throw new RangeError(`טווח גדול מדי (מקסימום ${max} כתובות בסריקה)`);
  const ips = [];
  for (let i = start; i <= end; i++) ips.push(longToIp(i));
  return ips;
}

// הרחבת CIDR לכתובות המארחים (בלי כתובת הרשת וה-broadcast), עם אותה בדיקת גודל מראש
function expandCIDR(cidr, max) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m || !isIPv4(m[1])) throw new RangeError('CIDR לא תקין');
  const prefix = parseInt(m[2], 10);
  if (prefix > 32) throw new RangeError('CIDR לא תקין');
  const total = 2 ** (32 - prefix);
  if (total - 2 > max) throw new RangeError(`טווח גדול מדי (מקסימום ${max} כתובות בסריקה)`);
  const base = Math.floor(ipToLong(m[1]) / total) * total;
  const ips = [];
  for (let i = 1; i < total - 1; i++) ips.push(longToIp(base + i));
  return ips;
}

module.exports = { isIPv4, ipToLong, longToIp, cleanText, intInRange, expandRange, expandCIDR };
