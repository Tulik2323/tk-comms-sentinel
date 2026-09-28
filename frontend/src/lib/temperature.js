// temperature.js — צבע ורמת חום של חיישן טמפרטורה
//
// חיישן יכול לכלול את הספים של הסוויץ' עצמו (warn / crit, כפי שהוא מדווח ב-SNMP). בלעדיהם משתמשים
// בברירת המחדל. שבב בתוך כרטיס קו מגיע בקלות ל-55 מעלות בלי שום בעיה (הסף שלו 88), ולכן צבע קבוע
// לכל הדגמים הציג סוויצ'ים תקינים בכתום.
export const TEMP_WARN_DEFAULT = 45;
export const TEMP_CRIT_DEFAULT = 60;

export function tempLimits(t) {
  const hasWarn = Number.isFinite(t?.warn) && t.warn > 0;
  const warn = hasWarn ? t.warn : TEMP_WARN_DEFAULT;
  // סף קריטי מהסוויץ', ואם דיווח רק אזהרה: 10 מעלות מעליה. בלי אף סף: ברירת המחדל
  const crit = Number.isFinite(t?.crit) && t.crit > warn ? t.crit : (hasWarn ? warn + 10 : TEMP_CRIT_DEFAULT);
  return { warn, crit };
}

// 'ok' | 'warn' | 'crit'
export function tempLevel(t) {
  const { warn, crit } = tempLimits(t);
  return t.celsius > crit ? 'crit' : t.celsius > warn ? 'warn' : 'ok';
}

export const TEMP_COLORS = { ok: '#22c55e', warn: '#f97316', crit: '#ef4444' };
