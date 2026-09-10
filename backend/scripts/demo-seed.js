// scripts/demo-seed.js — זרע נתוני demo: admin user + מכשירים מדומים
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { initDb } = require('../db/database');

async function main() {
  const db = await initDb();

  // --- צור משתמש admin ---
  const hash = await bcrypt.hash('admin123', 10);
  db.prepare(`
    INSERT OR REPLACE INTO user_accounts (username, password_hash, role)
    VALUES ('admin', ?, 'admin')
  `).run(hash);
  db.prepare(`
    INSERT OR REPLACE INTO user_accounts (username, password_hash, role)
    VALUES ('viewer', ?, 'viewer')
  `).run(await bcrypt.hash('viewer123', 10));

  // --- מכשירי demo ---
  const demoDevices = [
    { name: 'Core-SW-01',   ip: '192.168.1.1', sys_name: 'Core-SW-01',   sys_descr: 'HP Aruba CX 6300M - Core Switch', location: 'מרכז נתונים' },
    { name: 'Core-SW-02',   ip: '192.168.1.2', sys_name: 'Core-SW-02',   sys_descr: 'HP Aruba CX 6300M - Core Switch', location: 'מרכז נתונים' },
    { name: 'Dist-SW-01',   ip: '192.168.2.1', sys_name: 'Dist-SW-01',   sys_descr: 'HP Aruba CX 6200F - Distribution', location: 'קומה 1' },
    { name: 'Dist-SW-02',   ip: '192.168.2.2', sys_name: 'Dist-SW-02',   sys_descr: 'HP Aruba CX 6200F - Distribution', location: 'קומה 2' },
    { name: 'Access-SW-01', ip: '192.168.3.1', sys_name: 'Access-SW-01', sys_descr: 'HP Aruba 2530-48 - Access Switch', location: 'קומה 1 כנף צפון' },
    { name: 'Access-SW-02', ip: '192.168.3.2', sys_name: 'Access-SW-02', sys_descr: 'HP Aruba 2530-48 - Access Switch', location: 'קומה 1 כנף דרום' },
    { name: 'Access-SW-03', ip: '192.168.3.3', sys_name: 'Access-SW-03', sys_descr: 'HP Aruba 2530-48 - Access Switch', location: 'קומה 2 כנף מזרח' },
    { name: 'Access-SW-04', ip: '192.168.3.4', sys_name: 'Access-SW-04', sys_descr: 'HP Aruba 2530-48 - Access Switch', location: 'קומה 2 כנף מערב' },
    { name: 'WAN-Router',   ip: '192.168.0.1', sys_name: 'WAN-Router',   sys_descr: 'HP Aruba 7210 Controller', location: 'DMZ' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO devices (name, ip, community, sys_name, sys_descr, status, location, poll_interval_sec, map_x, map_y)
    VALUES (?, ?, 'public', ?, ?, 'up', ?, 60, ?, ?)
  `);

  const mapPositions = [
    [50, 10], [55, 10],   // Core
    [30, 35], [70, 35],   // Dist
    [15, 65], [35, 65],   // Access 1-2
    [60, 65], [80, 65],   // Access 3-4
    [50, 85],             // WAN
  ];

  demoDevices.forEach((d, i) => {
    const [mx, my] = mapPositions[i] || [50, 50];
    insert.run(d.name, d.ip, d.sys_name, d.sys_descr, d.location, mx, my);
  });

  // --- מיקומי מפה ---
  // כבר הוגדרו עם map_x/map_y למעלה

  // --- הוסף metrics demo ---
  const deviceIds = db.prepare('SELECT id FROM devices').all().map(d => d.id);
  const now       = Math.floor(Date.now() / 1000);
  const insertM   = db.prepare(`
    INSERT INTO metrics (device_id, ts, cpu_pct, mem_pct, total_in_bps, total_out_bps)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // 7 ימים * 24 שעות * 12 דגימות = נתוני demo
  for (const devId of deviceIds) {
    for (let h = 168; h >= 0; h--) {
      const ts = now - h * 3600;
      // גל סינוסואידי לדמות תבנית יום/לילה
      const timeOfDay = ((ts % 86400) / 86400);
      const load = 0.2 + 0.6 * Math.sin(timeOfDay * Math.PI) + (Math.random() - 0.5) * 0.1;
      insertM.run(
        devId, ts,
        Math.max(5, Math.min(95, load * 100 + (Math.random() - 0.5) * 10)),
        Math.max(20, Math.min(90, 40 + load * 30 + (Math.random() - 0.5) * 5)),
        Math.max(0, load * 800e6 + (Math.random() - 0.5) * 100e6),
        Math.max(0, load * 600e6 + (Math.random() - 0.5) * 80e6),
      );
    }
  }

  // --- ports demo (24 פורטים לכל מכשיר) ---
  const insertP = db.prepare(`
    INSERT OR IGNORE INTO ports (device_id, if_index, if_name, if_descr, if_speed, oper_status, admin_status, in_bps, out_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const devId of deviceIds) {
    for (let i = 1; i <= 24; i++) {
      const up = Math.random() > 0.15;
      insertP.run(
        devId, i,
        `${i < 10 ? '0' : ''}${i}`, `GigabitEthernet1/0/${i}`,
        1000000000,
        up ? 'up' : 'down',
        'up',
        up ? Math.random() * 100e6 : 0,
        up ? Math.random() * 80e6  : 0,
      );
    }
  }

  // --- קשרי LLDP demo ---
  const ids = db.prepare("SELECT id FROM devices ORDER BY id").all().map(d => d.id);
  const lldp = db.prepare(`
    INSERT OR IGNORE INTO lldp_links
      (local_device_id, local_port_index, remote_chassis_id, remote_sys_name, last_seen)
    VALUES (?, ?, ?, ?, unixepoch())
  `);
  // Core -> Dist -> Access
  if (ids.length >= 9) {
    const [c1,c2,d1,d2,a1,a2,a3,a4,wan] = ids;
    lldp.run(c1, 1, 'aabbcc000001', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(c2)?.sys_name);
    lldp.run(c1, 2, 'aabbcc000002', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(d1)?.sys_name);
    lldp.run(c2, 2, 'aabbcc000003', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(d2)?.sys_name);
    lldp.run(d1, 1, 'aabbcc000004', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(a1)?.sys_name);
    lldp.run(d1, 2, 'aabbcc000005', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(a2)?.sys_name);
    lldp.run(d2, 1, 'aabbcc000006', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(a3)?.sys_name);
    lldp.run(d2, 2, 'aabbcc000007', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(a4)?.sys_name);
    lldp.run(c1, 24, 'aabbcc000008', db.prepare('SELECT sys_name FROM devices WHERE id=?').get(wan)?.sys_name);
  }

  // --- הגדרות סף ברירת מחדל ---
  const insertT = db.prepare(`
    INSERT OR IGNORE INTO alert_thresholds (device_id, metric, threshold_pct, enabled)
    VALUES (NULL, ?, ?, 1)
  `);
  insertT.run('bandwidth_in',  80);
  insertT.run('bandwidth_out', 80);
  insertT.run('cpu',           90);
  insertT.run('mem',           85);

  console.log('✓ Demo data נטען בהצלחה!');
  console.log('  admin  / admin123  — הרשאות מלאות');
  console.log('  viewer / viewer123 — קריאה בלבד');
  process.exit(0);
}

main().catch(err => {
  console.error('שגיאה:', err.message);
  process.exit(1);
});
