require('dotenv').config();
const { initDb, getDb } = require('./db/database');

initDb().then(() => {
  const rows = getDb().prepare('SELECT key, value FROM system_settings').all();
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
});
