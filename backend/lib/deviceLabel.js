// lib/deviceLabel.js — שם תצוגה למכשיר: שם ידני, אחרת sysName מה-SNMP, אחרת IP.
// רוב המכשירים לא קיבלו שם ידני (name ריק/NULL) — בלי ה-fallback ל-sys_name
// התראות, יומנים ודוחות מציגים רק כתובת IP.
function deviceLabel(d) {
  if (!d) return '';
  const name = typeof d.name === 'string' ? d.name.trim() : d.name;
  const sys  = typeof d.sys_name === 'string' ? d.sys_name.trim() : d.sys_name;
  return name || sys || d.ip || '';
}

// ביטוי SQL שקול — לשאילתות שבונות את השם בצד ה-DB
const DEVICE_LABEL_SQL = (alias = 'd') =>
  `COALESCE(NULLIF(TRIM(${alias}.name), ''), NULLIF(TRIM(${alias}.sys_name), ''), ${alias}.ip)`;

module.exports = { deviceLabel, DEVICE_LABEL_SQL };
