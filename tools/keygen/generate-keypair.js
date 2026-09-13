// generate-keypair.js — one-time ED25519 keypair generation
// Run ONCE; embed the public key in backend/lib/license.js.
// Keep private.pem SAFE — never commit it (already in .gitignore).
//
// Usage: node generate-keypair.js
'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const dir = __dirname;
const privPath = path.join(dir, 'private.pem');
const pubPath  = path.join(dir, 'public.pem');

if (fs.existsSync(privPath)) {
  console.error('private.pem already exists — delete it first if you really want a new keypair.');
  console.error('WARNING: generating a new keypair invalidates ALL existing licenses.');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

fs.writeFileSync(privPath, privateKey, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(pubPath,  publicKey,  'utf8');

console.log('Keypair generated:');
console.log('  private.pem — keep this SAFE, never commit');
console.log('  public.pem  — embed this in backend/lib/license.js\n');
console.log(publicKey);
