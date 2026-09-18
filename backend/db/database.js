// db/database.js — SQLite דרך node:sqlite (מובנה ב-Node, ללא compilation)
// מחליף את sql.js: קובץ אמיתי עם נעילות OS במקום עותק בזיכרון שנכתב במלואו
// בכל שינוי — מה שאיפשר לתהליכים מקבילים לדרוס זה את זה.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

let _sqlDb  = null;   // ה-DatabaseSync הפנימי
let _facade = null;   // wrapper שמחקה better-sqlite3

// ---- נתיב ----

// נתיב יחסי נפתר מול שורש ה-backend, לא מול ה-CWD — כדי שה-poller
// יוכל לרוץ כתהליך נפרד שמופעל מכל תיקייה.
function getDbPath() {
  const configured = process.env.DB_PATH || './db/netmonitor.db';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(path.join(__dirname, '..'), configured);
}

// ---- המרת ערכים ----

// node:sqlite מקבל רק null/number/bigint/string/Buffer.
// ממיר undefined ו-boolean כמו ש-better-sqlite3 היה מצפה.
function toBindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ---- Statement wrapper (API זהה ל-better-sqlite3) ----

// שומר statements מוכנים לפי SQL — ה-poller מכין את אותן שאילתות
// בלולאות חמות, ואין טעם לקמפל אותן מחדש בכל איטרציה.
const _stmtCache = new Map();

function compiled(sql) {
  let stmt = _stmtCache.get(sql);
  if (!stmt) {
    stmt = _sqlDb.prepare(sql);
    _stmtCache.set(sql, stmt);
  }
  return stmt;
}

class Statement {
  constructor(sql) {
    this._sql = sql;
  }

  all(...args) {
    return compiled(this._sql).all(...args.flat().map(toBindable));
  }

  get(...args) {
    return compiled(this._sql).get(...args.flat().map(toBindable));
  }

  run(...args) {
    const { changes, lastInsertRowid } = compiled(this._sql).run(...args.flat().map(toBindable));
    // node:sqlite עשוי להחזיר BigInt בטבלאות גדולות — הקוד הקורא מצפה למספר
    return {
      changes:         typeof changes === 'bigint' ? Number(changes) : changes,
      lastInsertRowid: typeof lastInsertRowid === 'bigint' ? Number(lastInsertRowid) : lastInsertRowid,
    };
  }
}

// ---- DbFacade — ה-API החיצוני ----

class DbFacade {
  prepare(sql) {
    return new Statement(sql);
  }

  // מריץ SQL מרובה-שאילתות (למשל schema.sql)
  exec(sql) {
    _sqlDb.exec(sql);
  }

  // PRAGMA: journal_mode, foreign_keys וכו'
  pragma(str) {
    try { _sqlDb.exec(`PRAGMA ${str}`); } catch {}
  }

  // עוטף פונקציה ב-transaction
  transaction(fn) {
    return (...args) => {
      _sqlDb.exec('BEGIN');
      try {
        const result = fn(...args);
        _sqlDb.exec('COMMIT');
        return result;
      } catch (e) {
        try { _sqlDb.exec('ROLLBACK'); } catch {}
        throw e;
      }
    };
  }
}

// ---- Init (async, קרא פעם אחת מ-server.js) ----

async function initDb() {
  if (_facade) return _facade;

  const dbPath = getDbPath();
  const dir    = path.dirname(dbPath);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _sqlDb = new DatabaseSync(dbPath);

  // הגדרות ביצועים וזהות
  // WAL מאפשר קורא וכותב במקביל — קריטי כשה-poller בתהליך נפרד מה-web.
  _sqlDb.exec('PRAGMA journal_mode = WAL');
  _sqlDb.exec('PRAGMA foreign_keys = ON');
  _sqlDb.exec('PRAGMA synchronous = NORMAL');
  // אם תהליך אחר מחזיק כתיבה — המתן במקום ליפול על SQLITE_BUSY
  _sqlDb.exec('PRAGMA busy_timeout = 5000');

  // הפעל schema (יוצר טבלאות אם לא קיימות)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _sqlDb.exec(schema);

  // migrations — עמודות שנוספו אחרי schema ראשוני
  for (const sql of [
    'ALTER TABLE ports            ADD COLUMN if_alias      TEXT',
    'ALTER TABLE devices          ADD COLUMN vendor        TEXT',
    'ALTER TABLE devices          ADD COLUMN model         TEXT',
    'ALTER TABLE devices          ADD COLUMN hw_status     TEXT',
    'ALTER TABLE alert_thresholds ADD COLUMN port_if_index INTEGER',
    'ALTER TABLE alert_events     ADD COLUMN port_if_index INTEGER',
    'ALTER TABLE audit_log        ADD COLUMN msg_key       TEXT',
    'ALTER TABLE audit_log        ADD COLUMN msg_params    TEXT',
  ]) {
    try { _sqlDb.exec(sql); } catch (_) {}   // כבר קיים — מתעלמים
  }

  // unique index: אפשר סף ייעודי לפורט ספציפי (device + port + metric)
  try {
    _sqlDb.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_at_port_threshold ' +
      'ON alert_thresholds(device_id, port_if_index, metric) WHERE port_if_index IS NOT NULL'
    );
  } catch (_) {}

  // תיקון: UNIQUE(device_id, metric) לא מונע כפילויות כש-device_id IS NULL
  // (ב-SQLite NULL != NULL). מנקים כפילויות קיימות ומוסיפים partial index.
  _sqlDb.exec(`
    DELETE FROM alert_thresholds
    WHERE device_id IS NULL
      AND id NOT IN (
        SELECT MIN(id) FROM alert_thresholds
        WHERE device_id IS NULL
        GROUP BY metric
      )
  `);
  try {
    _sqlDb.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_at_global_metric ' +
      'ON alert_thresholds(metric) WHERE device_id IS NULL'
    );
  } catch (_) {}

  // הגדרות ברירת מחדל שנוספו בגרסאות מאוחרות
  _sqlDb.exec("INSERT OR IGNORE INTO system_settings VALUES ('app_base_url', '')");

  // Feature 2: port change log
  try { _sqlDb.exec('ALTER TABLE ports ADD COLUMN pvid INTEGER'); } catch (_) {}
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS port_changes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  INTEGER NOT NULL,
      if_index   INTEGER NOT NULL,
      if_name    TEXT,
      attribute  TEXT NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      changed_at INTEGER DEFAULT (unixepoch())
    )
  `);
  try { _sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_port_changes_lookup ON port_changes(device_id, changed_at DESC)'); } catch (_) {}

  // Feature 3: MAC/ARP table
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS mac_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mac_address TEXT NOT NULL,
      ip_address  TEXT,
      device_id   INTEGER NOT NULL,
      if_index    INTEGER,
      last_seen   INTEGER DEFAULT (unixepoch()),
      UNIQUE(mac_address, device_id)
    )
  `);
  try { _sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_mac_ip  ON mac_entries(ip_address)'); } catch (_) {}
  try { _sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_mac_mac ON mac_entries(mac_address)'); } catch (_) {}
  // אינדקס מכסה ל-COUNT(DISTINCT mac_address) פר-פורט (חיפוש endpoint —
  // זיהוי פורט קצה מול uplink). בלעדיו כל ספירה סורקת את כל הטבלה (~1M
  // שורות, ~86ms), והחיפוש נתקע. עם האינדקס: ~0ms.
  try { _sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_mac_devport ON mac_entries(device_id, phys_if_index, mac_address)'); } catch (_) {}
  try { _sqlDb.exec('ALTER TABLE mac_entries ADD COLUMN phys_if_index INTEGER'); } catch (_) {}

  // שמות VLAN שהמשתמש נותן בדף Inventory. category (אופציונלי) מסווג
  // תחנות שנשארו Unknown אחרי סיווג OUI/hostname.
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS vlan_names (
      vlan_id    INTEGER PRIMARY KEY,
      name       TEXT,
      category   TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // force=1: הקטגוריה של ה-VLAN גוברת גם על מכשירים שסווגו אוטומטית (ולא רק על Unknown).
  try { _sqlDb.exec('ALTER TABLE vlan_names ADD COLUMN force INTEGER DEFAULT 0'); } catch (_) {}

  // קטגוריות Inventory שהמשתמש הגדיר בעצמו (בנוסף לקטגוריות המובנות).
  // vlan_names.category מצביע אליהן במפתח 'custom_<id>'.
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS inv_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      icon       TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // מטמון תרגום IP -> hostname (reverse DNS). hostname=NULL means "checked,
  // no PTR record" — עדיין נשמר עם resolved_at כדי לא לנסות שוב מייד.
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS hostname_cache (
      ip          TEXT PRIMARY KEY,
      hostname    TEXT,
      resolved_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // היסטוריית תעבורה פר-פורט — שומרים 48 שעות אחורה
  _sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS port_samples (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  INTEGER NOT NULL,
      if_index   INTEGER NOT NULL,
      ts         INTEGER DEFAULT (unixepoch()),
      in_bps     REAL,
      out_bps    REAL,
      in_errors  INTEGER,
      out_errors INTEGER
    )
  `);
  try { _sqlDb.exec('CREATE INDEX IF NOT EXISTS idx_port_samples ON port_samples(device_id, if_index, ts)'); } catch (_) {}

  // סגירה מסודרת. אין יותר צורך לייצא את ה-DB לדיסק — SQLite כותב
  // בעצמו — ולכן גם אין את מרוץ ה-exit שגרם ל-UV_HANDLE_CLOSING.
  const closeQuietly = () => {
    try { _stmtCache.clear(); _sqlDb.close(); } catch {}
  };
  process.on('SIGINT',  () => { closeQuietly(); process.exit(0); });
  process.on('SIGTERM', () => { closeQuietly(); process.exit(0); });

  _facade = new DbFacade();
  console.log(`[DB] מסד נתונים: ${dbPath}`);
  return _facade;
}

function getDb() {
  if (!_facade) throw new Error('[DB] לא אותחל — קרא initDb() לפני שימוש');
  return _facade;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = { initDb, getDb, getSetting, setSetting };
