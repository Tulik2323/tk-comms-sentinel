// .env: TKCS_DATA_DIR כשמוגדר, אחרת __dirname — ראה ההערה ב-scripts/seed-admin.js.
require('dotenv').config({ path: require('path').join(process.env.TKCS_DATA_DIR || __dirname, '.env') });
const { initDb, getDb } = require('./db/database');

initDb().then(() => {
  const rows = getDb().prepare('SELECT key, value FROM system_settings').all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
});
