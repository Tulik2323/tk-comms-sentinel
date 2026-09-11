// .env: TKCS_DATA_DIR כשמוגדר, אחרת __dirname — ראה ההערה ב-scripts/seed-admin.js.
require('dotenv').config({ path: require('path').join(process.env.TKCS_DATA_DIR || __dirname, '.env') });
const { initDb, getDb } = require('./db/database');

initDb().then(() => {
  const db = getDb();

  const count = db.prepare('SELECT COUNT(*) as n FROM lldp_links').get();
  console.log('סה"כ רשומות lldp_links:', count.n);

  if (count.n > 0) {
    const rows = db.prepare('SELECT * FROM lldp_links LIMIT 20').all();
    console.log('\nדוגמאות:\n', JSON.stringify(rows, null, 2));

    const unmatched = db.prepare(`
      SELECT l.*, d_remote.id AS matched_id
      FROM lldp_links l
      LEFT JOIN devices d_remote ON (
        d_remote.sys_name = l.remote_sys_name
        OR d_remote.ip = l.remote_sys_name
      )
      WHERE d_remote.id IS NULL
      LIMIT 10
    `).all();
    console.log('\nרשומות ללא התאמה לdevice (remote_device_id=NULL):', unmatched.length);
    if (unmatched.length > 0) console.log(JSON.stringify(unmatched, null, 2));
  } else {
    console.log('\nטבלה ריקה — LLDP לא נאסף עדיין.');
    console.log('בדוק שהpoll רץ לפחות פעם אחת ושהסוויצ\'ים תומכים ב-LLDP MIB (1.0.8802).');
  }

  process.exit(0);
});
