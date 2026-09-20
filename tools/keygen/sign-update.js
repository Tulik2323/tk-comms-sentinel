// sign-update.js — sign an update-feed entry with the vendor key (used by deploy-local.ps1)
// Run on YOUR machine (where private.pem lives). Never run on customer machines.
//
// Usage:
//   node sign-update.js <version> <sha256> <downloadUrl>
// Prints the signature (base64url) on stdout, nothing else.
//
// The signed message must match updateMessage() in backend/routes/updates.js exactly:
//   "tkcs-update-v1\n<version>\n<sha256 lowercase>\n<downloadUrl>"
// The app verifies it with the public key embedded in backend/lib/license.js, so a feed that is not
// signed with this key can never make an installation download and run a package.
'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const [,, version, sha256, downloadUrl] = process.argv;

if (!version || !sha256 || !downloadUrl) {
  console.error('Usage: node sign-update.js <version> <sha256> <downloadUrl>');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+([.\-][a-zA-Z0-9]+)*$/.test(version)) { console.error('version is not semver'); process.exit(1); }
if (!/^[0-9a-fA-F]{64}$/.test(sha256))                    { console.error('sha256 must be 64 hex characters'); process.exit(1); }
if (!/^https:\/\//.test(downloadUrl))                     { console.error('downloadUrl must be https'); process.exit(1); }

const privPath = path.join(__dirname, 'private.pem');
if (!fs.existsSync(privPath)) {
  console.error('private.pem not found in tools/keygen/ — cannot sign the update feed.');
  process.exit(2);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));

// Refuse to sign with a key that does not match the public key inside the app: such a signature
// would be rejected by every installation, which is worse than no signature (it hides the mistake).
const licenseSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'lib', 'license.js'), 'utf8');
const pem = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/.exec(licenseSrc);
if (!pem) { console.error('could not find the embedded public key in backend/lib/license.js'); process.exit(3); }
const embedded = crypto.createPublicKey(pem[0]).export({ type: 'spki', format: 'der' });
const derived  = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
if (!embedded.equals(derived)) {
  console.error('private.pem does not match the public key embedded in the app — not signing.');
  process.exit(4);
}

const message   = `tkcs-update-v1\n${version}\n${sha256.toLowerCase()}\n${downloadUrl}`;
const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
process.stdout.write(signature.toString('base64url'));
