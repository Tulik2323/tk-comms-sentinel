// staleness — האם הנתונים של מכשיר ישנים. uptime_at נשמר בכל קריאת SNMP מוצלחת
// (מ-1.15.0); last_poll_ts (רשימת המכשירים) משמש כגיבוי עד הקריאה הראשונה.
// בלי הסימון הזה מתג שלא נבדק 11 שעות הוצג ירוק עם זמן פעולה של 49 ימים, אחרי שאותחל.
export function lastReadTs(d) {
  return (d && (d.uptime_at || d.last_poll_ts)) || null;
}

export function isStale(d) {
  const ts = lastReadTs(d);
  if (!ts) return false;
  const limitSec = Math.max(3 * (Number(d.poll_interval_sec) || 300), 900);
  return Date.now() / 1000 - ts > limitSec;
}

export function fmtSince(ts, locale) {
  return new Date(ts * 1000).toLocaleString(locale, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
