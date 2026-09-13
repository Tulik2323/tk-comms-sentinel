// issue-license.js — generate a signed license key for a customer
// Run on YOUR machine (where private.pem lives). Never run on customer machines.
//
// Usage:
//   node issue-license.js <fingerprint> <expiry-YYYY-MM-DD> [customer] [grace-days]
//
// Example:
//   node issue-license.js ABCDE-FGHIJ-KLMNO-PQRST 2027-09-13 "Poria Hospital" 30
//
// The fingerprint is shown on the License tab inside the running app.
// Send the output key to the customer; they paste it into the License tab.
'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const [,, fingerprint, expiry, customer = 'Customer', graceDaysStr = '30'] = process.argv;

if (!fingerprint || !expiry) {
  console.error('Usage: node issue-license.js <XXXXX-XXXXX-XXXXX-XXXXX> <YYYY-MM-DD> [customer] [grace-days]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
  console.error('Error: expiry must be YYYY-MM-DD (e.g. 2027-09-13)');
  process.exit(1);
}
if (!/^[A-F0-9]{5}-[A-F0-9]{5}-[A-F0-9]{5}-[A-F0-9]{5}$/i.test(fingerprint)) {
  console.error('Warning: fingerprint format looks wrong (expected XXXXX-XXXXX-XXXXX-XXXXX hex)');
}

const grace      = parseInt(graceDaysStr, 10) || 30;
const privPath   = path.join(__dirname, 'private.pem');

if (!fs.existsSync(privPath)) {
  console.error('private.pem not found in tools/keygen/ — run generate-keypair.js first.');
  process.exit(1);
}

const privateKey = fs.readFileSync(privPath, 'utf8');

const payload     = { fp: fingerprint, exp: expiry, grace, cust: customer, iat: new Date().toISOString().slice(0, 10) };
const payloadJson = JSON.stringify(payload);
const payloadB64  = Buffer.from(payloadJson).toString('base64url');
const signature   = crypto.sign(null, Buffer.from(payloadJson), privateKey);
const sigB64      = signature.toString('base64url');
const licenseKey  = `${payloadB64}.${sigB64}`;

console.log('\n=== LICENSE KEY (send this to the customer) ===');
console.log(licenseKey);
console.log('================================================');
console.log(`\nCustomer    : ${customer}`);
console.log(`Fingerprint : ${fingerprint}`);
console.log(`Expiry      : ${expiry}`);
console.log(`Grace period: ${grace} days after expiry`);
console.log(`Issued      : ${payload.iat}`);
