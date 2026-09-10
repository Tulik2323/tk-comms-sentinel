-- ===== טבלת מכשירים =====
CREATE TABLE IF NOT EXISTS devices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT,
  ip                TEXT UNIQUE NOT NULL,
  snmp_version      TEXT DEFAULT 'v2c',       -- v2c / v3
  community         TEXT DEFAULT 'public',     -- v2c community string
  snmp_v3_user      TEXT,                      -- v3 security name
  snmp_v3_auth      TEXT,                      -- v3 auth password
  snmp_v3_priv      TEXT,                      -- v3 priv password
  poll_interval_sec INTEGER DEFAULT 300,       -- כל כמה שניות לבדוק
  status            TEXT DEFAULT 'unknown',    -- up / down / unknown
  sys_name          TEXT,                      -- sysName מ-SNMP
  sys_descr         TEXT,                      -- תיאור המכשיר
  uptime_sec        INTEGER,                   -- uptime בשניות
  map_x             REAL,                      -- מיקום X על תמונת מפה (אחוז)
  map_y             REAL,                      -- מיקום Y על תמונת מפה (אחוז)
  location          TEXT,                      -- תיאור מיקום חופשי
  notes             TEXT,                      -- הערות
  created_at        INTEGER DEFAULT (unixepoch())
);

-- ===== היסטוריית מטריקות (נשמרת בכל poll) =====
CREATE TABLE IF NOT EXISTS metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,            -- unix timestamp
  cpu_pct         REAL,                        -- אחוז CPU
  mem_pct         REAL,                        -- אחוז זיכרון
  total_in_bps    REAL,                        -- סך תעבורה נכנסת בbit/s
  total_out_bps   REAL                         -- סך תעבורה יוצאת בbit/s
);
CREATE INDEX IF NOT EXISTS idx_metrics_device_ts ON metrics(device_id, ts);

-- ===== פורטים (מתעדכן בכל poll) =====
CREATE TABLE IF NOT EXISTS ports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  if_index     INTEGER NOT NULL,               -- ifIndex מ-SNMP
  if_name      TEXT,                           -- ifName
  if_descr     TEXT,                           -- ifDescr
  if_speed     BIGINT DEFAULT 0,               -- מהירות ב-bps (0 = לא ידוע)
  oper_status  TEXT DEFAULT 'unknown',         -- up / down / testing / unknown
  admin_status TEXT DEFAULT 'unknown',         -- up / down
  in_bps       REAL DEFAULT 0,                 -- תעבורה נכנסת נוכחית
  out_bps      REAL DEFAULT 0,                 -- תעבורה יוצאת נוכחית
  in_errors    BIGINT DEFAULT 0,
  out_errors   BIGINT DEFAULT 0,
  last_updated INTEGER,
  UNIQUE(device_id, if_index)
);

-- ===== קשרי LLDP לבניית טופולוגיה =====
CREATE TABLE IF NOT EXISTS lldp_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  local_device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  local_port_index    INTEGER,
  remote_chassis_id   TEXT,                    -- MAC של המכשיר המרוחק
  remote_port_id      TEXT,
  remote_sys_name     TEXT,
  last_seen           INTEGER,
  UNIQUE(local_device_id, local_port_index, remote_chassis_id)
);

-- ===== הגדרות סף להתראות לכל מכשיר =====
CREATE TABLE IF NOT EXISTS alert_thresholds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,  -- NULL = ברירת מחדל גלובלית
  metric        TEXT NOT NULL,                 -- bandwidth_in / bandwidth_out / cpu / mem / status
  threshold_pct REAL NOT NULL DEFAULT 80,
  enabled       INTEGER DEFAULT 1,
  UNIQUE(device_id, metric)
);

-- ===== לוג התראות שנשלחו =====
CREATE TABLE IF NOT EXISTS alert_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  metric      TEXT,
  value       REAL,
  threshold   REAL,
  message     TEXT,
  sent_at     INTEGER DEFAULT (unixepoch()),
  resolved_at INTEGER                          -- NULL = טרם נפתר
);
CREATE INDEX IF NOT EXISTS idx_alert_events_ts ON alert_events(sent_at);

-- ===== חשבונות משתמשים (לdemo ולשמירת TOTP) =====
CREATE TABLE IF NOT EXISTS user_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT UNIQUE NOT NULL,
  password_hash TEXT,                          -- bcrypt, משמש רק ב-DEMO_MODE
  role         TEXT NOT NULL DEFAULT 'viewer', -- admin / viewer
  totp_secret  TEXT,                           -- סוד TOTP (מוצפן בbase32)
  totp_enabled INTEGER DEFAULT 0,
  last_login   INTEGER,
  created_at   INTEGER DEFAULT (unixepoch())
);

-- ===== תמונת מפה (PNG/JPG של הבניין/קומה) =====
CREATE TABLE IF NOT EXISTS floor_map (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  image_data BLOB,
  mime_type  TEXT,
  updated_at INTEGER
);

-- ===== הגדרות מערכת (key-value) =====
CREATE TABLE IF NOT EXISTS system_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ===== לוג אירועי מערכת (AUDIT) =====
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL DEFAULT (unixepoch()),
  level     TEXT NOT NULL DEFAULT 'info',   -- info / warn / error
  source    TEXT NOT NULL DEFAULT 'system', -- poller / auth / admin / system
  message   TEXT NOT NULL,
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  ip        TEXT,
  username  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- ===== תזמון דוחות =====
CREATE TABLE IF NOT EXISTS report_schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  report_type TEXT NOT NULL,
  params      TEXT,
  cron_expr   TEXT NOT NULL,
  email_to    TEXT,
  enabled     INTEGER DEFAULT 1,
  last_run    INTEGER,
  created_at  INTEGER DEFAULT (unixepoch())
);

-- ערכי ברירת מחדל להגדרות
INSERT OR IGNORE INTO system_settings VALUES ('smtp_host', '');
INSERT OR IGNORE INTO system_settings VALUES ('smtp_port', '25');
INSERT OR IGNORE INTO system_settings VALUES ('smtp_from', 'netmonitor@company.local');
INSERT OR IGNORE INTO system_settings VALUES ('smtp_user', '');
INSERT OR IGNORE INTO system_settings VALUES ('smtp_pass', '');
INSERT OR IGNORE INTO system_settings VALUES ('alert_recipients', '');
INSERT OR IGNORE INTO system_settings VALUES ('ldap_url', '');
INSERT OR IGNORE INTO system_settings VALUES ('ldap_base_dn', '');
INSERT OR IGNORE INTO system_settings VALUES ('ldap_bind_dn', '');
INSERT OR IGNORE INTO system_settings VALUES ('ldap_bind_password', '');
INSERT OR IGNORE INTO system_settings VALUES ('ad_admin_group', 'NetMonitor_Admins');
INSERT OR IGNORE INTO system_settings VALUES ('ad_viewer_group', 'NetMonitor_Viewers');
INSERT OR IGNORE INTO system_settings VALUES ('default_poll_interval', '300');
INSERT OR IGNORE INTO system_settings VALUES ('retention_days', '7');
INSERT OR IGNORE INTO system_settings VALUES ('alert_quiet_from', '02:00');
INSERT OR IGNORE INTO system_settings VALUES ('alert_quiet_to',   '08:00');
