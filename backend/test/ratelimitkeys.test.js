// Who a rate limit counts.
//
//   SEC-19  The signed-in limiters (search, import and restore) counted per IP, so
//           a household behind one router shared one budget: one person's import
//           spent everyone's. They now count per account.
//   SEC-04  TRUST_PROXY=true became Express's `true`, which takes the LEFT-most
//           X-Forwarded-For entry -- one the client writes itself -- so rotating
//           that header walked past every IP limit, sign-in included. "true" now
//           means one hop. (e2e/hardening.test.js drives it through server.js.)
//
// The real limiters in this process, on a bare app with a stand-in auth gate.
// Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

// middleware/auth loads db.js, which opens its file on require.
const tmpDb = path.join(os.tmpdir(), `bindarr-ratelimitkeys-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const { importLimiter, searchLimiter, trustProxySetting } = require('../src/middleware/auth');

let server;

async function main() {
  // --- SEC-04: what TRUST_PROXY means --------------------------------------------
  const one = trustProxySetting('true');
  assert.strictEqual(one.value, 1, '"true" is one hop, never "trust every hop"');
  assert.match(one.warning, /TRUST_PROXY=1/, 'and the boot log says so');
  assert.strictEqual(trustProxySetting('TRUE').value, 1);
  assert.deepStrictEqual(trustProxySetting('1'), { value: 1 });
  assert.deepStrictEqual(trustProxySetting(' 2 '), { value: 2 });
  assert.deepStrictEqual(trustProxySetting('loopback'), { value: 'loopback' }, 'an Express trust string is kept');
  assert.deepStrictEqual(trustProxySetting('10.0.0.0/8, 127.0.0.1'), { value: '10.0.0.0/8, 127.0.0.1' });
  assert.deepStrictEqual(trustProxySetting(''), { value: undefined });
  assert.deepStrictEqual(trustProxySetting(undefined), { value: undefined });

  // With one hop, the address a proxy appended is the client; whatever the
  // client wrote to the left of it is not.
  const probe = express();
  probe.set('trust proxy', one.value);
  probe.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const probeServer = await new Promise(resolve => { const s = http.createServer(probe).listen(0, '127.0.0.1', () => resolve(s)); });
  const ipFor = async (xff) => (await (await fetch(`http://127.0.0.1:${probeServer.address().port}/ip`, { headers: { 'X-Forwarded-For': xff } })).json()).ip;
  assert.strictEqual(await ipFor('6.6.6.6, 203.0.113.7'), '203.0.113.7');
  assert.strictEqual(await ipFor('7.7.7.7, 203.0.113.7'), '203.0.113.7', 'a rotated left-most entry is the same client');
  await new Promise(resolve => probeServer.close(resolve));
  console.log('PASS: TRUST_PROXY=true is one hop');

  // --- SEC-19: per account ------------------------------------------------------
  const app = express();
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user']) }; next(); });
  app.post('/api/import', importLimiter, (req, res) => res.json({ ok: true }));
  app.get('/api/search', searchLimiter, (req, res) => res.json({ ok: true }));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const as = (user, method, p) => fetch(base + p, { method, headers: { 'x-test-user': String(user) } }).then(r => r.status);

  for (let i = 0; i < 20; i++) assert.strictEqual(await as(1, 'POST', '/api/import'), 200);
  assert.strictEqual(await as(1, 'POST', '/api/import'), 429, 'one account spends its own import budget');
  assert.strictEqual(await as(2, 'POST', '/api/import'), 200, 'and not its housemate\'s, from the same address');

  for (let i = 0; i < 300; i++) assert.strictEqual(await as(1, 'GET', '/api/search'), 200);
  assert.strictEqual(await as(1, 'GET', '/api/search'), 429);
  assert.strictEqual(await as(2, 'GET', '/api/search'), 200, 'the search budget is per account too');
  console.log('PASS: signed-in limiters count per account, not per address');

  console.log('PASS: ratelimitkeys.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    try { await new Promise(resolve => require('../src/db').dbConnection.close(() => resolve())); } catch { /* not open */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  });
