#!/usr/bin/env node
// scripts/build-oui-lookup.js
// Converts the IEEE OUI CSV (or decimal-per-line format) → backend/data/oui.json
// Usage: node scripts/build-oui-lookup.js [path-to-oui.csv]
//   Default input:  C:\Users\{USER}\AppData\Local\Temp\oui.csv
//   Default output: backend/data/oui.json

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const inputPath  = process.argv[2] || path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'oui.csv');
const outputPath = path.join(__dirname, '..', 'data', 'oui.json');

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

console.log(`Reading: ${inputPath}`);
let raw = fs.readFileSync(inputPath, 'utf8');

// Detect decimal-per-line format: every line is a 1-3 digit integer
const firstLine = raw.split('\n')[0].trim();
if (/^\d{1,3}$/.test(firstLine)) {
  console.log('Detected decimal-per-line format — decoding...');
  raw = raw.trim().split('\n')
    .map(l => String.fromCharCode(parseInt(l.trim())))
    .join('');
}

// Parse CSV: Registry,Assignment,Organization Name,Organization Address
const lines = raw.replace(/\r/g, '').split('\n');
const lookup = {};
let parsed = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  // Split: field1,field2,"possibly, quoted field",rest...
  // Fields: Registry, Assignment (6-hex OUI), Org Name, Org Address
  const parts = [];
  let cur = '';
  let inQ  = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"')      { inQ = !inQ; }
    else if (ch === ',' && !inQ) { parts.push(cur); cur = ''; }
    else                 { cur += ch; }
  }
  parts.push(cur);

  if (parts.length < 3) continue;
  const oui    = parts[1].trim().toUpperCase();
  const vendor = parts[2].trim();
  if (!/^[0-9A-F]{6}$/.test(oui)) continue;

  lookup[oui] = vendor;
  parsed++;
}

fs.writeFileSync(outputPath, JSON.stringify(lookup), 'utf8');
console.log(`Written ${parsed} OUI entries to: ${outputPath}`);
console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
