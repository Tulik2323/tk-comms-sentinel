// בונה מחדש את הודעת ה-audit log מ-msg_key+msg_params, כדי שתוצג בשפה
// הנבחרת. שורות ישנות בלי msg_key נופלות חזרה ל-message שנשמר ב-DB.
export function formatAuditMessage(row, t) {
  if (!row.msg_key) return row.message || '';
  let params = {};
  try { params = row.msg_params ? JSON.parse(row.msg_params) : {}; } catch (_) {}
  const key = `audit_${row.msg_key}`;
  const translated = t(key, params);
  return translated === key ? (row.message || '') : translated;
}
