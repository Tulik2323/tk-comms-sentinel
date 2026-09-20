// services/csv.js — כתיבת CSV בטוחה לפתיחה ב-Excel
//
// תא שמתחיל ב- = + - @ (או ב-tab / CR) נפתח ב-Excel כנוסחה, ושמות מכשירים ותיאורי פורטים
// מגיעים מהמכשירים עצמם דרך SNMP — מי ששולט בתיאור של פורט בסוויץ' יכול לשתול בו נוסחה
// שתרוץ אצל מי שפותח את הדוח. לכן תא כזה מקבל גרש בהתחלה ונשאר טקסט. מספר טהור (למשל -5)
// לא נוגעים בו.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER  = /^[+-]?\d+(\.\d+)?$/;

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

module.exports = { csvCell, toCSV };
