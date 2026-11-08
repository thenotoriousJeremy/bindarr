// Binder artwork (issue #104): upload validation, per-user scoping, and the
// public read through a shared container.
//
// The DB lives in its own temp directory because artwork files are stored
// beside the database (binder-art/), and they must not land in a directory
// other runs share.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-binderart-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const express = require('express');
const sharp = require('sharp');
const db = require('../src/db');
const store = require('../src/utils/binderArtStore');
const binderArtRoutes = require('../src/routes/binderArt');
const sharedRoutes = require('../src/routes/shared');

function send(port, method, urlPath, { user, body, type } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (user) headers['x-test-user'] = String(user);
    let payload = null;
    if (Buffer.isBuffer(body)) {
      payload = body;
      headers['content-type'] = type || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = buf;
        if (String(res.headers['content-type'] || '').includes('json')) {
          try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = buf.toString('utf8'); }
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server = null;

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function main() {
  await db.initDb();
  const alice = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled, share_locations) VALUES ('alice', 'x', 'member', 'alice-share', 1, 1)`
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled, share_locations) VALUES ('bob', 'x', 'member', 'bob-share', 1, 1)`
  )).lastID;
  const binder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Art binder', 'Binder', ?)`, [alice])).lastID;
  const page1 = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [binder])).lastID;
  const otherBinder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Plain', 'Binder', ?)`, [alice])).lastID;
  await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [otherBinder]);

  const app = express();
  app.use(express.json());
  app.use('/api/shared', sharedRoutes);
  app.use('/api', (req, res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (!id) return res.status(401).json({ error: 'auth' });
    req.user = { id };
    next();
  });
  app.use('/api', binderArtRoutes);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // --- Upload validation ---
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .png().toBuffer();
  const up = await send(port, 'POST', '/api/binder-art', { user: alice, body: png, type: 'image/png' });
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  assert.deepStrictEqual([up.body.artwork.width, up.body.artwork.height, up.body.artwork.mime], [40, 30, 'image/png']);
  const artId = up.body.artwork.id;
  assert.ok(fs.existsSync(path.join(tmpDir, 'binder-art', String(alice), String(artId))), 'stored beside the database, per user');

  const junk = await send(port, 'POST', '/api/binder-art', { user: alice, body: Buffer.from('definitely not a png'), type: 'image/png' });
  assert.strictEqual(junk.status, 400, 'bytes that do not decode are refused');

  const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).gif().toBuffer();
  const wrongType = await send(port, 'POST', '/api/binder-art', { user: alice, body: gif, type: 'image/gif' });
  assert.strictEqual(wrongType.status, 400, 'a content type outside JPEG/PNG/WebP is not even parsed');
  const disguised = await send(port, 'POST', '/api/binder-art', { user: alice, body: gif, type: 'image/png' });
  assert.strictEqual(disguised.status, 400, 'a GIF labelled PNG is refused by its decoded format');

  const huge = Buffer.alloc(store.MAX_UPLOAD_BYTES + 1024, 1);
  const tooBig = await send(port, 'POST', '/api/binder-art', { user: alice, body: huge, type: 'image/jpeg' });
  assert.strictEqual(tooBig.status, 413);
  assert.match(tooBig.body.error, /12 MB/);

  // EXIF is dropped by the re-encode: a shared page must not carry a phone's GPS.
  const withExif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'secret-marker' } } }).jpeg().toBuffer();
  assert.ok(withExif.includes(Buffer.from('secret-marker')));
  const exifUp = await send(port, 'POST', '/api/binder-art', { user: alice, body: withExif, type: 'image/jpeg' });
  assert.strictEqual(exifUp.status, 201);
  const exifImg = await send(port, 'GET', `/api/binder-art/${exifUp.body.artwork.id}/image`, { user: alice });
  assert.strictEqual(exifImg.status, 200);
  assert.ok(!exifImg.body.includes(Buffer.from('secret-marker')), 'EXIF stripped');

  // --- Cross-user access ---
  const own = await send(port, 'GET', `/api/binder-art/${artId}/image`, { user: alice });
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.headers['content-type'], 'image/png');
  const stolen = await send(port, 'GET', `/api/binder-art/${artId}/image`, { user: bob });
  assert.strictEqual(stolen.status, 404, "bob cannot read alice's image");

  const layerBody = {
    artwork_id: artId, x_mm: 94.5, y_mm: 132, width_mm: 189, rotation_deg: -90,
    spread: false, pocket_w_mm: 63, pocket_h_mm: 88, gap_mm: 2,
    mask: [{ side: 'left', row: 0, col: 0 }, { side: 'left', row: 0, col: 0 }, { side: 'right', row: 0, col: 1 }, { side: 'left', row: 2, col: 2 }],
  };
  const bobOnAlicePage = await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, { user: bob, body: layerBody });
  assert.strictEqual(bobOnAlicePage.status, 404, "bob cannot place art on alice's page");
  const bobBinder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Bob', 'Binder', ?)`, [bob])).lastID;
  const bobPage = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [bobBinder])).lastID;
  const bobWithAliceArt = await send(port, 'PUT', `/api/compartments/${bobPage}/binder-art`, { user: bob, body: layerBody });
  assert.strictEqual(bobWithAliceArt.status, 400, "bob cannot place alice's artwork on his own page");

  const saved = await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, { user: alice, body: layerBody });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.deepStrictEqual(saved.body.layer.mask, [{ side: 'left', row: 0, col: 0 }, { side: 'left', row: 2, col: 2 }],
    'duplicates dropped, and no right-page pocket without a spread');
  assert.strictEqual(saved.body.layer.rotation_deg, 270, 'rotation normalised');
  assert.strictEqual(saved.body.layer.gap_mm, 2);

  const badMask = await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, {
    user: alice, body: { ...layerBody, mask: [{ side: 'left', row: -1, col: 0 }] },
  });
  assert.strictEqual(badMask.status, 400);
  const badPocket = await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, {
    user: alice, body: { ...layerBody, pocket_w_mm: 5 },
  });
  assert.strictEqual(badPocket.status, 400);

  const listedBob = await send(port, 'GET', `/api/locations/${binder}/binder-art`, { user: bob });
  assert.strictEqual(listedBob.status, 404);
  const listed = await send(port, 'GET', `/api/locations/${binder}/binder-art`, { user: alice });
  assert.strictEqual(listed.body.layers.length, 1);
  assert.strictEqual(listed.body.layers[0].width, 40, 'layer carries the picture size for aspect');
  const bobDelete = await send(port, 'DELETE', `/api/compartments/${page1}/binder-art`, { user: bob });
  assert.strictEqual(bobDelete.status, 404);

  // --- Share path ---
  const sharedContainer = await send(port, 'GET', `/api/shared/alice-share/containers/${binder}`);
  assert.strictEqual(sharedContainer.status, 200);
  assert.strictEqual(sharedContainer.body.artwork.length, 1);
  const imageUrl = sharedContainer.body.artwork[0].image_url;
  assert.strictEqual(imageUrl, `/api/shared/alice-share/containers/${binder}/art/${artId}`);
  assert.ok(!('user_id' in sharedContainer.body.artwork[0]));
  const publicImg = await send(port, 'GET', imageUrl);
  assert.strictEqual(publicImg.status, 200);
  assert.strictEqual(publicImg.body.length, own.body.length);

  // Only through the container the art is on, and only with the right token.
  assert.strictEqual((await send(port, 'GET', `/api/shared/alice-share/containers/${otherBinder}/art/${artId}`)).status, 404);
  assert.strictEqual((await send(port, 'GET', `/api/shared/bob-share/containers/${binder}/art/${artId}`)).status, 404);
  // An upload that is not placed on any page stays private.
  assert.strictEqual((await send(port, 'GET', `/api/shared/alice-share/containers/${binder}/art/${exifUp.body.artwork.id}`)).status, 404);
  // Turning off location sharing closes the image too.
  await db.run(`UPDATE users SET share_locations = 0 WHERE id = ?`, [alice]);
  assert.strictEqual((await send(port, 'GET', imageUrl)).status, 404);
  await db.run(`UPDATE users SET share_locations = 1, share_enabled = 0 WHERE id = ?`, [alice]);
  assert.strictEqual((await send(port, 'GET', imageUrl)).status, 404);
  await db.run(`UPDATE users SET share_enabled = 1 WHERE id = ?`, [alice]);

  // --- Artwork is not a card ---
  const cards = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [alice]);
  assert.strictEqual(cards.n, 0, 'nothing reaches collection');

  // --- Replacing and clearing tidy up the old image ---
  const second = await send(port, 'POST', '/api/binder-art', { user: alice, body: png, type: 'image/png' });
  const replaced = await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, {
    user: alice, body: { ...layerBody, artwork_id: second.body.artwork.id },
  });
  assert.strictEqual(replaced.status, 200);
  assert.strictEqual(fs.existsSync(path.join(tmpDir, 'binder-art', String(alice), String(artId))), false, 'replaced image removed');
  assert.strictEqual(await db.get(`SELECT id FROM binder_artwork WHERE id = ?`, [artId]), undefined);

  const cleared = await send(port, 'DELETE', `/api/compartments/${page1}/binder-art`, { user: alice });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual((await send(port, 'GET', `/api/locations/${binder}/binder-art`, { user: alice })).body.layers.length, 0);
  assert.strictEqual(fs.existsSync(path.join(tmpDir, 'binder-art', String(alice), String(second.body.artwork.id))), false);

  // Deleting the page drops its layer with it.
  const third = await send(port, 'POST', '/api/binder-art', { user: alice, body: png, type: 'image/png' });
  await send(port, 'PUT', `/api/compartments/${page1}/binder-art`, { user: alice, body: { ...layerBody, artwork_id: third.body.artwork.id } });
  await db.run(`DELETE FROM compartments WHERE id = ?`, [page1]);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM binder_art_layers`)).n, 0);

  console.log('binderArt.test.js: all assertions passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server && server.listening) await new Promise(r => server.close(r));
    await new Promise(r => { try { db.dbConnection.close(() => r()); } catch { r(); } });
    cleanup();
  });
