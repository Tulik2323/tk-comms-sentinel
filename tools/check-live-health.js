// check-live-health.js <host> <port> <version> — used by deploy-local.ps1 after the app pool restart.
// Exits 0 once https://<host>:<port>/api/health answers 200 with the expected version, 1 after 60s.
// Node rather than Invoke-WebRequest: PowerShell 5.1 cannot finish the TLS handshake with this server.
// rejectUnauthorized=false: the live certificate comes from the internal CA, which Node does not trust;
// this only reads the public health endpoint of our own server.
const https = require('https');
const [host, port, want] = process.argv.slice(2);
const deadline = Date.now() + 60000;

function retry(why) {
  if (Date.now() > deadline) { console.log(`live check FAILED: ${why}`); process.exit(1); }
  setTimeout(attempt, 2000);
}

function attempt() {
  const req = https.get({ host, port, path: '/api/health', rejectUnauthorized: false, timeout: 10000 }, (res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      let version = null;
      try { version = JSON.parse(body).version; } catch (_) {}
      if (res.statusCode === 200 && version === want) { console.log(`live ${version} OK`); process.exit(0); }
      retry(`HTTP ${res.statusCode}, version ${version}`);
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', e => retry(e.message));
}

attempt();
