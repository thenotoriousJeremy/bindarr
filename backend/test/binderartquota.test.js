// Binder-art uploads check the quota before doing the expensive work (SEC-14).
//
// sharp decoded and re-encoded each upload (up to 16,000 x 16,000 pixels, a
// gigabyte of RGBA) before the 200-artwork quota was even checked, and nothing
// limited how often. Now the quota is checked before the upload is read, uploads
// are rate-limited per user, and the pixel ceiling is 64 megapixels, refused from
// the image header with a message that says so.
//
// The real router in this process, with a stand-in for the auth gate, as
// binderArt.test.js does. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-binderartquota-'));
process.env.DB_PATH = path.join(tmpDir, 'bindarr.db');

const express = require('express');
const db = require('../src/db');
const store = require('../src/utils/binderArtStore');

let server;
async function cleanup() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
}

// A PNG whose header claims width x height, with almost no pixel data behind it.
function pngClaiming(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await db.initDb();
  const sharp = require('sharp');
  const addUser = async (name) => (await db.run(
    `INSERT INTO users (username, password_hash, share_token) VALUES (?, 'x', ?)`, [name, `tok-${name}`]
  )).lastID;
  const full = await addUser('full');
  const roomy = await addUser('roomy');
  const busy = await addUser('busy');

  // Count every decode the route asks for.
  let prepared = 0;
  const realPrepare = store.prepare;
  store.prepare = async (...args) => { prepared++; return realPrepare(...args); };

  const app = express();
  app.use('/api', (req, res, next) => { req.user = { id: Number(req.headers['x-test-user']) }; next(); });
  app.use('/api', require('../src/routes/binderArt'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const upload = async (userId, body) => {
    const res = await fetch(`${base}/api/binder-art`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-test-user': String(userId) }, body,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();

  // --- a full account is refused before any decoding -------------------------------
  for (let i = 0; i < 200; i++) {
    await db.run(`INSERT INTO binder_artwork (user_id, mime, width, height, bytes) VALUES (?, 'image/png', 20, 20, 10)`, [full]);
  }
  prepared = 0;
  let r = await upload(full, png);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.strictEqual(prepared, 0, 'the image was never decoded for an upload the quota refuses');
  r = await upload(roomy, png);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(prepared, 1);
  console.log('PASS: the quota is checked before the upload is decoded');

  // --- the pixel ceiling, said as such ------------------------------------------------
  assert.strictEqual(store.MAX_INPUT_PIXELS, 8000 * 8000);
  r = await upload(roomy, pngClaiming(9000, 9000));
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /pixels/, 'an image over the ceiling is refused for its size, not as unreadable');
  console.log('PASS: images over 64 megapixels are refused from their header');

  // --- uploads are rate-limited per user ----------------------------------------------
  for (let i = 0; i < 60; i++) {
    assert.notStrictEqual((await upload(busy, Buffer.from('not an image'))).status, 429, `upload ${i + 1} is within the limit`);
  }
  r = await upload(busy, png);
  assert.strictEqual(r.status, 429, 'the sixty-first upload in an hour is refused');
  assert.strictEqual((await upload(roomy, png)).status, 201, 'another user has their own budget');
  console.log('PASS: binder-art uploads are rate-limited per user');

  console.log('PASS: binderartquota.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
