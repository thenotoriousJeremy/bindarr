// Set here as well as in run.js: a suite run on its own boots a server on a fresh
// database, which would otherwise run a full TCGCSV sync at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.BINDARR_DISABLE_FX_SYNC = '1';

// server.js wiring from the security review, driven through a real server:
//
//   SEC-04  TRUST_PROXY=true is one hop, so a client rotating the left-most
//           X-Forwarded-For entry no longer escapes the sign-in limit; and the
//           boot log says what "true" was taken to mean.
//   SEC-03  A restore is counted against the import budget before its body is
//           parsed, and a member's body limit is smaller than an admin's.
//   SEC-16  /api/card-art takes the 8 MB images the client allows (base64 in
//           JSON), not the 1 MB global limit; past that it says so.
//   SEC-17  The global error handler says "Bad request body" only for body-parser
//           errors.
//   SEC-15  Prometheus metrics without a token are warned about at boot.
//   SEC-06  A fresh install prints its setup code at boot, and the code is what a
//           request from elsewhere needs to create the owner.
//
// Offline, on free ports, with throwaway databases (harness.js).
const assert = require('assert');
const http = require('http');
const harness = require('./harness');
const { freePort } = require('../freePort');

const tmp = harness.tempDatabase('hardening');
const db = require('../../src/db');

let srv;
let fresh;
let freshTmp;

const waitForLog = async (server, pattern, ms = 5000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    const match = server.tail(100000).match(pattern);
    if (match) return match;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
};

// POST a JSON body of exactly `bytes` bytes, {"backup":"xxx..."}, streamed.
function postSized(port, pathname, headers, bytes) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(bytes) },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (error) => resolve({ status: 0, error: error.message }));
    const head = '{"backup":"';
    const tail = '"}';
    let left = bytes - head.length - tail.length;
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    req.write(head);
    const pump = () => {
      while (left > 0) {
        const part = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= part.length;
        if (!req.write(part)) { req.once('drain', pump); return; }
      }
      req.end(tail);
    };
    pump();
  });
}

async function runTests() {
  const prometheusPort = await freePort();
  srv = await harness.startServer(tmp, {
    env: {
      TRUST_PROXY: 'true',
      PROMETHEUS_METRICS_ENABLED: 'true',
      PROMETHEUS_PORT: String(prometheusPort),
      PROMETHEUS_METRICS_TOKEN: '',
    },
  });
  const admin = await harness.admin(db);

  // --- boot warnings ---------------------------------------------------------------
  assert.ok(await waitForLog(srv, /TRUST_PROXY=true is read as TRUST_PROXY=1/), 'the boot log explains TRUST_PROXY=true');
  assert.ok(await waitForLog(srv, /PROMETHEUS_METRICS_TOKEN is not set/), 'the boot log warns about tokenless metrics');
  console.log('PASS: SEC-04/SEC-15 - boot warnings for TRUST_PROXY=true and tokenless metrics');

  // --- SEC-04: a rotated left-most X-Forwarded-For does not reset the limit -----------
  let lastStatus = 0;
  for (let i = 0; i < 21; i++) {
    const r = await srv.request('POST', '/api/auth/login', {
      body: { username: 'admin', password: `wrong-${i}` },
      headers: { 'X-Forwarded-For': `198.51.100.${i + 1}, 203.0.113.7` },
    });
    lastStatus = r.status;
    if (i < 20) assert.strictEqual(r.status, 401, `failure ${i + 1}: ${r.status} ${r.text}`);
  }
  assert.strictEqual(lastStatus, 429, 'the client behind the proxy is one client, whatever it puts in front of the proxy\'s entry');
  const other = await srv.request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'wrong' }, headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.8' },
  });
  assert.strictEqual(other.status, 401, 'a different client behind the same proxy has its own budget');
  console.log('PASS: SEC-04 - TRUST_PROXY=true takes one hop, so spoofing the header does not reset the limit');

  // --- SEC-03: the restore limiter runs before the parser ------------------------------
  const restorer = await harness.member(db, 'restorer');
  for (let i = 0; i < 20; i++) {
    const r = await srv.request('POST', '/api/backup/restore', { as: restorer, body: {} });
    assert.strictEqual(r.status, 400, `restore ${i + 1}: ${r.status} ${r.text}`);
  }
  const broken = await srv.request('POST', '/api/backup/restore', {
    as: restorer, body: '{"backup": "unterminated', headers: { 'Content-Type': 'application/json' },
  });
  assert.strictEqual(broken.status, 429, `the 21st restore is refused before its body is parsed, got ${broken.status} ${broken.text}`);

  // A member's ceiling is lower than an admin's: 110 MB is too much for a member
  // and is read (then found not to be a backup) for an admin.
  const sizer = await harness.member(db, 'sizer');
  const size = 110 * 1024 * 1024;
  const asMember = await postSized(srv.port, '/api/backup/restore', sizer.headers, size);
  assert.strictEqual(asMember.status, 413, `a member's 110 MB restore is too large: ${JSON.stringify(asMember)}`);
  const asAdmin = await postSized(srv.port, '/api/backup/restore', admin.headers, size);
  assert.strictEqual(asAdmin.status, 400, `an admin's is within the limit: ${JSON.stringify(asAdmin).slice(0, 200)}`);
  assert.match(asAdmin.body, /Not a Bindarr backup file/);
  console.log('PASS: SEC-03 - restores are limited before parsing, with a smaller body limit for members');

  // --- SEC-16: card art up to 8 MB ------------------------------------------------------
  const sharp = require('sharp');
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-hardening-art', 'Art Card', 'mtg')`);
  const noise = (side) => sharp(require('crypto').randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
  const twoMb = await noise(900);
  assert.ok(twoMb.length > 1.5 * 1024 * 1024, 'the test image is well past the old ~786 KB ceiling');
  let r = await srv.request('POST', '/api/card-art/mtg-hardening-art', {
    as: admin, body: { image: `data:image/png;base64,${twoMb.toString('base64')}` }, timeoutMs: 60000,
  });
  assert.strictEqual(r.status, 200, `a ${(twoMb.length / 1048576).toFixed(1)} MB image uploads: ${r.status} ${r.text.slice(0, 200)}`);
  const nineMb = await noise(1750);
  r = await srv.request('POST', '/api/card-art/mtg-hardening-art', {
    as: admin, body: { image: `data:image/png;base64,${nineMb.toString('base64')}` }, timeoutMs: 60000,
  });
  assert.strictEqual(r.status, 413);
  assert.match(r.json.error, /8 MB/, 'past the limit, the answer is about the image, not import batches');
  const anon = await srv.request('POST', '/api/card-art/mtg-hardening-art', { body: { image: 'data:image/png;base64,AAAA' } });
  assert.strictEqual(anon.status, 401, 'and nobody signed out gets as far as the parser');
  console.log('PASS: SEC-16 - card art takes images up to 8 MB');

  // --- SEC-17: what the global error handler calls a body problem ------------------------
  r = await srv.request('POST', '/api/notes', { as: admin, body: '{"title": "unterminated' });
  assert.deepStrictEqual([r.status, r.json && r.json.error], [400, 'Request body is not valid JSON']);
  r = await srv.request('POST', '/api/notes', { as: admin, body: '{}', headers: { 'Content-Type': 'application/json; charset=ebcdic' } });
  assert.deepStrictEqual([r.status, r.json && r.json.error], [415, 'Bad request body'], 'body-parser errors keep their wording');
  // The admin backup download was the one route that handed send's 404 to the
  // global handler; it answers for itself now (backupdownload.test.js has the
  // dot-folder case).
  r = await srv.request('GET', '/api/admin/backups/missing.bak/download', { as: admin });
  assert.deepStrictEqual([r.status, r.json], [404, { error: 'Backup not found' }]);
  console.log('PASS: SEC-17 - body-parser errors keep their wording; a missing backup is not a bad request body');

  await srv.stop();
  srv = null;

  // --- SEC-06: a fresh install prints its setup code --------------------------------------
  freshTmp = harness.tempDatabase('hardening-fresh');
  fresh = await harness.startServer(freshTmp, { env: { DEFAULT_ADMIN_PASSWORD: '' } });
  const printed = await waitForLog(fresh, /Setup code: ([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/);
  assert.ok(printed, `the setup code is in the boot log:\n${fresh.tail(20)}`);
  const elsewhere = { 'X-Forwarded-For': '203.0.113.50' };
  const cfg = await fresh.request('GET', '/api/auth/config', { headers: elsewhere });
  assert.strictEqual(cfg.json.setupCodeRequired, true);
  assert.strictEqual(cfg.json.version, require('../../package.json').version);
  r = await fresh.request('POST', '/api/auth/bootstrap', { body: { password: 'owner-password-1' }, headers: elsewhere });
  assert.strictEqual(r.status, 403, 'no code, no owner');
  r = await fresh.request('POST', '/api/auth/bootstrap', { body: { password: 'owner-password-1', setup_code: printed[1] }, headers: elsewhere });
  assert.strictEqual(r.status, 201, `the printed code creates the owner: ${r.text}`);
  console.log('PASS: SEC-06 - a fresh install prints a setup code, and it claims the install');
}

runTests()
  .then(async () => {
    if (srv) await srv.stop();
    if (fresh) await fresh.stop();
    await harness.cleanup(db, tmp);
    if (freshTmp) require('fs').rmSync(freshTmp.dir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    for (const s of [srv, fresh]) {
      if (!s) continue;
      console.error(`--- server log (tail) ---\n${s.tail(60)}`);
      try { await s.stop(); } catch { /* already down */ }
    }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
