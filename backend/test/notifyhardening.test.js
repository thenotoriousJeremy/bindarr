// Notification sends are bounded in time, and the SSRF guard no longer reads out
// the server's internal DNS.
//
//   SEC-07  Only an idle timeout applied, so a receiver dripping a byte every few
//           seconds held a send open indefinitely; deliveries go one at a time, so
//           that one channel delayed every other user's notifications. And past
//           the byte cap the body was still read to its end. Now the whole
//           exchange has a deadline, and the response is cut off at the cap.
//   SEC-08  "db.internal resolves to 10.0.0.5" let a member map internal hosts,
//           with no limit on saving channels. Now a hostname that does not
//           resolve and one that resolves somewhere blocked get the same sentence,
//           and the lookups a member can trigger are rate-limited per user.
//
// Local receivers on 127.0.0.1 and a stubbed DNS: nothing leaves the machine.
// Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const dns = require('dns');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-notifyhardening-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const notify = require('../src/notify');
const guard = require('../src/utils/notifyGuard');

// The DNS this test lives in: one internal name, one public one, one that does not
// exist. Anything else (the receivers' own 127.0.0.1) goes to the real lookup.
const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  const answers = { 'db.internal': '10.0.0.5', 'hooks.example': '93.184.216.34' };
  if (hostname === 'nowhere.example') {
    return process.nextTick(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })));
  }
  if (!answers[hostname]) return realLookup(hostname, options, callback);
  const list = [{ address: answers[hostname], family: 4 }];
  return process.nextTick(() => (options.all ? callback(null, list) : callback(null, list[0].address, 4)));
};

const servers = [];
async function cleanup() {
  dns.lookup = realLookup;
  for (const s of servers) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    if (s.listening) await new Promise(resolve => s.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const listen = (handler) => new Promise(resolve => {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// Settles with the promise, or with 'hung' if it has not after `ms`.
const within = (promise, ms) => Promise.race([
  promise.then(value => ({ value }), error => ({ error })),
  new Promise(resolve => setTimeout(() => resolve('hung'), ms)),
]);

async function main() {
  await db.initDb();
  process.env.NOTIFY_ALLOW_PRIVATE = 'true';   // the receivers are on loopback

  // --- SEC-07: a drip-feeding receiver ----------------------------------------------
  const timers = [];
  const drip = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const t = setInterval(() => res.write('.'), 100);
    timers.push(t);
    res.on('close', () => clearInterval(t));
  });
  const started = Date.now();
  const dripped = await within(notify.post(`${drip}/hook`, { hello: 1 }, {}, 600), 5000);
  assert.notStrictEqual(dripped, 'hung', 'a receiver that never finishes must not hold the send past its deadline');
  assert.ok(dripped.error && /timed out/.test(dripped.error.message), `the send fails as a timeout, got ${JSON.stringify(dripped)}`);
  assert.ok(Date.now() - started < 3000, 'and it fails near the deadline, not whenever the receiver stops');
  console.log('PASS: a send has an overall deadline, not just an idle timeout');

  // --- SEC-07: a receiver that sends more than the cap, forever ---------------------
  const chunk = Buffer.alloc(16 * 1024, 'x');
  let written = 0;
  const flood = await listen((req, res) => {
    req.resume();
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    const pump = () => {
      while (written < 200 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    res.on('close', () => { written = Infinity; });
    pump();
  });
  const flooded = await within(notify.post(`${flood}/hook`, {}, {}, 10000), 5000);
  assert.notStrictEqual(flooded, 'hung', 'past the byte cap the response is not read to its end');
  assert.ok(flooded.value, `the status still comes back: ${JSON.stringify(flooded.error && flooded.error.message)}`);
  assert.strictEqual(flooded.value.status, 500);
  assert.ok(flooded.value.text.length <= 64 * 1024, 'and only the capped amount is kept');
  console.log('PASS: a response is cut off at the byte cap');
  for (const t of timers) clearInterval(t);

  // --- SEC-08: one sentence for "unresolvable" and "resolves somewhere blocked" -----
  delete process.env.NOTIFY_ALLOW_PRIVATE;
  const internal = await guard.checkUrl('http://db.internal/hook').then(() => null, e => e.message);
  const missing = await guard.checkUrl('http://nowhere.example/hook').then(() => null, e => e.message);
  assert.ok(internal && missing, 'both are refused');
  assert.ok(!internal.includes('10.0.0.5'), `the refusal must not carry the resolved address: ${internal}`);
  assert.strictEqual(internal.replace('db.internal', 'HOST'), missing.replace('nowhere.example', 'HOST'),
    'an internal name and a name that does not exist read the same');
  const atConnect = await new Promise(resolve => guard.guardedLookup('db.internal', {}, err => resolve(err)));
  assert.strictEqual(atConnect && atConnect.code, 'NOTIFY_BLOCKED');
  assert.ok(!atConnect.message.includes('10.0.0.5'), 'nor does the connect-time refusal, which a test send shows');
  assert.strictEqual(await guard.checkUrl('http://hooks.example/hook').then(u => u.hostname), 'hooks.example', 'a public host passes');
  console.log('PASS: the SSRF guard does not reveal what an internal name resolves to');

  // --- SEC-08: lookups a member can trigger are rate-limited per user ---------------
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user']), role: 'member' }; next(); });
  app.use('/api/notifications', require('../src/routes/notifications'));
  const base = await listen(app);
  const create = async (userId, url) => {
    const res = await fetch(`${base}/api/notifications/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': String(userId) },
      body: JSON.stringify({ type: 'webhook', url }),
    });
    return { status: res.status, json: await res.json() };
  };
  const mallory = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('mallory', 'x', 'tok-m')`)).lastID;
  const trent = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('trent', 'x', 'tok-t')`)).lastID;
  for (let i = 0; i < 5; i++) {
    const r = await create(mallory, i % 2 ? 'http://db.internal/x' : `http://hooks.example/${i}`);
    assert.ok([201, 400].includes(r.status), `lookup ${i + 1} is answered: ${r.status}`);
  }
  const sixth = await create(mallory, 'http://hooks.example/6');
  assert.strictEqual(sixth.status, 429, 'the sixth lookup in a minute is refused');
  assert.strictEqual((await create(mallory, 'http://10.9.9.9/x')).status, 400,
    'an address literal needs no lookup, so it is judged rather than throttled');
  assert.strictEqual((await create(trent, 'http://hooks.example/t')).status, 201, 'another user has their own budget');
  console.log('PASS: channel URL lookups are rate-limited per user');

  console.log('PASS: notifyhardening.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    // The flood receiver may still be mid-write on a destroyed socket.
    process.exit(process.exitCode || 0);
  });
