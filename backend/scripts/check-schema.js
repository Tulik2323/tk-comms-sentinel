// scripts/check-schema.js — read-only look at the database structure.
//
//   node check-schema.js            → list tables
//   node check-schema.js <table>    → that table's columns + row count
//
// A fixed, reviewed script so schema checks never need ad-hoc code run through node.
// Opens the DB read-only and never writes. The table name is matched against the real
// table list before it reaches any SQL, so arbitrary input cannot be injected.
//
// Finds the DB the way the server does: .env from TKCS_DATA_DIR (installed layout,
// where it sits in data\) or from backend\ itself (IIS / flat deploy), then DB_PATH
// resolved against the backend root.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const backendRoot = path.join(__dirname, '..');
const dataDir     = process.env.TKCS_DATA_DIR || backendRoot;
try { require('dotenv').config({ path: path.join(dataDir, '.env') }); } catch (_) {}

const configured = process.env.DB_PATH || './db/netmonitor.db';
const dbPath = path.isAbsolute(configured) ? configured : path.resolve(backendRoot, configured);

const db = new DatabaseSync(dbPath, { readOnly: true });
console.log(`DB: ${dbPath}`);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map(t => t.name);

const requested = process.argv[2];

if (!requested) {
  console.log('Tables:');
  tables.forEach(t => console.log(' -', t));
} else if (!tables.includes(requested)) {
  console.log(`No such table: ${requested}`);
  console.log('Known tables:', tables.join(', '));
} else {
  const cols = db.prepare(`PRAGMA table_info("${requested}")`).all();
  console.log(`${requested} columns:`);
  cols.forEach(c => console.log(` ${c.cid}\t${c.name}\t${c.type}`));

  const count = db.prepare(`SELECT COUNT(*) AS n FROM "${requested}"`).get();
  console.log(`row count: ${count.n}`);
}

db.close();
