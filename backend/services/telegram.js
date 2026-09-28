// services/telegram.js — התראות לטלגרם, בנוסף למייל (המייל ממשיך לקבל הכול כמו קודם)
//
// המשתמש בוחר בהגדרות אילו סוגי התראות יעלו לטלגרם (telegram_types). התראות פורט עמוס מושהות:
// הן עולות רק אם העומס נמשך telegram_port_min דקות, כך שפורט שמתמלא לרגע וחוזר לא מציף את הצ'אט.
// שעות השקט (alert_quiet_from / alert_quiet_to) לא חלות על טלגרם.
//
// כמו שליחת המייל, השליחה כאן לעולם לא מחזיקה את לולאת ה-polling: כשל רשת מושהה לכמה דקות ולא נזרק.
const https = require('https');
const { getDb, getSetting } = require('../db/database');
const { decrypt } = require('./secrets');

// סוגי ההתראות שאפשר לבחור. המפתח נשמר ב-telegram_types (רשימה מופרדת בפסיקים).
const KINDS = ['device_down', 'device_up', 'path_outage', 'device_bandwidth', 'cpu', 'mem', 'port_bandwidth'];
const DEFAULT_PORT_MIN = 15;

const BACKOFF_MS = 5 * 60 * 1000;
let _failedUntil = 0;

const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
// מספר (קבוצות הן שליליות) או @שם_ערוץ
const CHAT_RE  = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,})$/;

function parseChatIds(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

// טוקן ו-Chat ID תקינים? מחזיר null כשכן, אחרת הודעה שאפשר לפעול לפיה
function validateConfig(token, chatIds) {
  if (!token) return 'לא הוגדר Bot Token';
  if (!TOKEN_RE.test(token)) return 'ה-Bot Token לא נראה תקין (צורה: 123456789:AA... כפי שקיבלת מ-BotFather)';
  if (!chatIds.length) return 'לא הוגדר Chat ID';
  if (!chatIds.every(c => CHAT_RE.test(c))) return 'Chat ID לא תקין (מספר, מספר שלילי לקבוצה, או @שם_ערוץ; כמה מופרדים בפסיק)';
  return null;
}

function readConfig() {
  const token   = decrypt(getSetting('telegram_bot_token') || '');
  const chatIds = parseChatIds(getSetting('telegram_chat_id'));
  const stored  = getSetting('telegram_types');
  // לא הוגדר מעולם = כל הסוגים; מחרוזת ריקה שנשמרה במפורש = אף סוג
  const types   = stored == null ? KINDS.slice() : String(stored).split(',').map(s => s.trim()).filter(k => KINDS.includes(k));
  const portMin = parseInt(getSetting('telegram_port_min'), 10);
  return {
    enabled: getSetting('telegram_enabled') === '1',
    token, chatIds, types,
    portMin: Number.isFinite(portMin) && portMin >= 0 ? portMin : DEFAULT_PORT_MIN,
  };
}

// קריאה ל-Bot API. מחזיר את שדה result, או זורק שגיאה עם הסבר.
function callApi(token, method, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      host: 'api.telegram.org', port: 443, method: 'POST', path: `/bot${token}/${method}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        if (json && json.ok) return resolve(json.result);
        const err = new Error((json && json.description) || `HTTP ${res.statusCode}`);
        err.telegramCode = json && json.error_code;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// הודעת שגיאה שאפשר לפעול לפיה, במקום קוד גולמי
function explainError(err) {
  const m = err.message || String(err);
  if (err.telegramCode === 401 || /unauthorized/i.test(m)) return 'ה-Bot Token נדחה על ידי טלגרם. העתק אותו שוב מ-BotFather.';
  if (err.telegramCode === 400 && /chat not found/i.test(m)) return 'הצ\'אט לא נמצא. שלח קודם הודעה כלשהי לבוט (או הוסף אותו לקבוצה) ואז לחץ "מצא Chat ID".';
  if (err.telegramCode === 403) return 'הבוט חסום או הוסר מהצ\'אט. שלח לו הודעה או הוסף אותו מחדש.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'לא ניתן לפתור את api.telegram.org. בדוק DNS בשרת.';
  if (/ETIMEDOUT|timeout|ECONNREFUSED|ECONNRESET/i.test(m)) return 'אין גישה ל-api.telegram.org בפורט 443 מהשרת. בדוק חומת אש או פרוקסי.';
  return m;
}

// שולח הודעה לכל ה-Chat IDs. זורק אם כולם נכשלו. משמש את הבדיקה הידנית.
async function sendNow(token, chatIds, text) {
  let lastErr = null, sent = 0;
  for (const chat_id of chatIds) {
    try {
      await callApi(token, 'sendMessage', { chat_id, text, disable_web_page_preview: true });
      sent++;
    } catch (e) { lastErr = e; }
  }
  if (!sent) throw lastErr || new Error('לא נשלח');
  return sent;
}

// שליחת התראה לפי סוג. לא ממתין לתוצאה. מחזיר Promise<boolean>: האם ההודעה נשלחה בפועל
// (משמש את מנגנון ההשהיה, שמסמן פורט כשנשלח רק אחרי שליחה מוצלחת).
function sendTelegram(kind, text) {
  try {
    const cfg = readConfig();
    if (!cfg.enabled || !cfg.types.includes(kind)) return Promise.resolve(false);
    if (validateConfig(cfg.token, cfg.chatIds)) return Promise.resolve(false);
    if (Date.now() < _failedUntil) return Promise.resolve(false);

    return sendNow(cfg.token, cfg.chatIds, text)
      .then(() => { _failedUntil = 0; console.log(`[Telegram] נשלח (${kind})`); return true; })
      .catch((err) => {
        _failedUntil = Date.now() + BACKOFF_MS;
        console.error(`[Telegram] כשל בשליחה (${explainError(err)}). משהה ניסיונות ל-${BACKOFF_MS / 60000} דקות.`);
        return false;
      });
  } catch (err) {
    console.error('[Telegram] שגיאה בהכנת הודעה:', err.message);
    return Promise.resolve(false);
  }
}

// התראות פורט עמוס שממתינות. רץ פעם בדקה ב-poller: אירוע פורט שנשאר פתוח לפחות telegram_port_min
// דקות מאז שנוצר עולה לטלגרם. אירוע שנסגר קודם (הפורט חזר לתקין) אף פעם לא עולה.
async function flushDelayedPortAlerts() {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.types.includes('port_bandwidth')) return;
  if (validateConfig(cfg.token, cfg.chatIds) || Date.now() < _failedUntil) return;

  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - cfg.portMin * 60;
  const rows = db.prepare(`
    SELECT id, device_id, message, sent_at, port_if_index
    FROM alert_events
    WHERE metric IN ('port_bandwidth_in','port_bandwidth_out')
      AND resolved_at IS NULL AND tg_sent_at IS NULL AND sent_at <= ? AND sent_at > ?
    ORDER BY sent_at LIMIT 20
  `).all(cutoff, Math.floor(Date.now() / 1000) - 6 * 3600);   // אירוע פתוח ישן מ-6 שעות הוא שארית, לא התראה חדשה

  const base = (getSetting('app_base_url') || '').trim().replace(/\/$/, '');
  for (const r of rows) {
    const mins = Math.max(cfg.portMin, Math.round((Date.now() / 1000 - r.sent_at) / 60));
    const link = base && r.device_id ? `\n${base}/devices/${r.device_id}?port=${r.port_if_index}` : '';
    const ok = await sendTelegram('port_bandwidth', `🔌 פורט עמוס — נמשך ${mins} דקות\n${r.message}${link}`);
    if (!ok) return;   // טלגרם לא זמין: מנסים שוב בדקה הבאה, בלי לסמן
    db.prepare('UPDATE alert_events SET tg_sent_at = unixepoch() WHERE id = ?').run(r.id);
  }
}

module.exports = {
  KINDS, DEFAULT_PORT_MIN, TOKEN_RE, CHAT_RE,
  parseChatIds, validateConfig, readConfig, callApi, explainError, sendNow, sendTelegram, flushDelayedPortAlerts,
};
