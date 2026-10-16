// deviceLabel — שם תצוגה למכשיר: שם ידני, אחרת sysName מה-SNMP, אחרת IP.
// רוב המכשירים לא קיבלו שם ידני, ובלי ה-fallback ל-sys_name המסכים מציגים רק IP.
export function deviceLabel(d) {
  if (!d) return '';
  const name = typeof d.name === 'string' ? d.name.trim() : d.name;
  const sys  = typeof d.sys_name === 'string' ? d.sys_name.trim() : d.sys_name;
  return name || sys || d.ip || '';
}
