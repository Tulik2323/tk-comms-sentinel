// services/secrets.js — הצפנת ערכים רגישים ב-DB (AES-256-GCM)
// המפתח נשמר מחוץ לשורש האתר ב-C:\ProgramData\tknetmonitor\settings.key
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const KEY_PATH  = 'C:\\ProgramData\\tknetmonitor\\settings.key';
const ALGO      = 'aes-256-gcm';
const PREFIX    = 'enc1:';  // סימן שהערך מוצפן

let _key = null;

function loadKey() {
  if (_key) return _key;

  if (fs.existsSync(KEY_PATH)) {
    const hex = fs.readFileSync(KEY_PATH, 'utf8').trim();
    _key = Buffer.from(hex, 'hex');
  } else {
    _key = crypto.randomBytes(32);
    const dir = path.dirname(KEY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(KEY_PATH, _key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    console.log(`[Secrets] מפתח הצפנה חדש נוצר: ${KEY_PATH}`);
  }
  return _key;
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key    = loadKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;  // plaintext ישן — תמיכה לאחורה
  try {
    const key     = loadKey();
    const buf     = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
    const iv      = buf.subarray(0, 12);
    const tag     = buf.subarray(12, 28);
    const enc     = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  } catch (e) {
    console.error('[Secrets] כשל פענוח:', e.message);
    return '';
  }
}

module.exports = { encrypt, decrypt };
