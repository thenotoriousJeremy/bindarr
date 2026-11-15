// A member's backup restore can no longer reach into other accounts or the
// operator's provider credits.
//
//   SEC-01  A restored sealed unit's claim named any account the file liked, so a
//           member could plant a box in someone else's sealed list. Now only the
//           file owner's own claim is kept (as the restorer's); any other is
//           dropped. And a restore, which deletes the restorer's purchases, is
//           refused while another account has claimed one of their units -- the
//           same rule sealed.js applies to deleting a purchase.
//   SEC-03  Every card the install had not cached cost one provider request, with
//           no cap. A member's restore now looks up at most 5000 (the /import
//           row cap) and refuses a bigger file before the first request.
//
// Same shape as backuprestore.test.js: the real router in this process, the auth
// middleware and cardApi swapped in the require cache. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-restoresecurity-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');

let user = null;
const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/middleware/auth', {
  ...require('../src/middleware/auth'),
  authenticateToken: (req, res, next) => { req.user = user; next(); },
});
const lookups = [];
stubModule('../src/utils/cardApi', {
  ...require('../src/utils/cardApi'),
  getCardById: async (id) => { lookups.push(id); return null; },
});

let server;
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const restore = async (base, backup) => {
  const res = await fetch(`${base}/api/backup/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }),
  });
  return { status: res.status, body: await res.json() };
};

async function addUser(name, role = 'member') {
  return (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', ?, ?)`,
    [name, role, `share-${name}-${process.pid}`]
  )).lastID;
}

async function main() {
  await db.initDb();
  const alice = await addUser('alice');
  const bob = await addUser('bob');
  const carol = await addUser('carol');
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-known-1', 'Known Card', 'mtg')`);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', require('../src/middleware/auth').authenticateToken);
  app.use('/api', require('../src/routes/backup'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  // A file "from another install", whose purchase belonged to account 999 there.
  // Unit 1 was claimed by that owner; unit 2 claims to be alice's (planted).
  const file = (extra = {}) => ({
    format: 'bindarr-backup',
    version: 1,
    data: {
      sealed_purchases: [{ id: 50, user_id: 999, product_name: 'Booster Box', quantity: 3, available_to_all: 1 }],
      sealed_units: [
        { id: 70, purchase_id: 50, claimed_by_user_id: 999 },
        { id: 71, purchase_id: 50, claimed_by_user_id: alice },
        { id: 72, purchase_id: 50, claimed_by_user_id: null },
      ],
      collection: [{ id: 1, card_id: 'mtg-known-1', quantity: 1, game: 'mtg' }],
      ...extra,
    },
  });

  // --- SEC-01: claims ---------------------------------------------------------------
  user = { id: bob, role: 'member' };
  let r = await restore(base, file());
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const units = await db.all(
    `SELECT u.claimed_by_user_id AS claimed FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE p.user_id = ? ORDER BY u.id`, [bob]
  );
  assert.deepStrictEqual(units.map(u => u.claimed), [bob, null, null],
    "the file owner's claim becomes the restorer's; any other claim is dropped");
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM sealed_units WHERE claimed_by_user_id = ?`, [alice])).n, 0,
    "nothing was planted in alice's sealed list");
  console.log('PASS: a restore keeps only the file owner\'s own claims');

  // Carol claims one of bob's units, the way opening a shared box does.
  const unclaimed = await db.get(
    `SELECT u.id FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE p.user_id = ? AND u.claimed_by_user_id IS NULL LIMIT 1`, [bob]
  );
  await db.run(`UPDATE sealed_units SET claimed_by_user_id = ? WHERE id = ?`, [carol, unclaimed.id]);
  const before = (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [bob])).n;
  r = await restore(base, file({ collection: [] }));
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'restore_claimed_units');
  assert.strictEqual((await db.get(`SELECT claimed_by_user_id AS c FROM sealed_units WHERE id = ?`, [unclaimed.id])).c, carol,
    "carol's unit is still there, still hers");
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [bob])).n, before,
    'and nothing else was changed');
  console.log('PASS: a restore is refused while another account has claimed one of the restorer\'s units');

  // --- SEC-03: provider lookups are capped ------------------------------------------
  user = { id: alice, role: 'member' };
  const many = Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, card_id: `mtg-uncached-${i}`, quantity: 1 }));
  lookups.length = 0;
  r = await restore(base, file({ collection: many, sealed_purchases: [], sealed_units: [] }));
  assert.strictEqual(r.status, 413, JSON.stringify(r.body).slice(0, 300));
  assert.strictEqual(r.body.code, 'restore_too_many_cards');
  assert.deepStrictEqual(r.body.params, { count: 5001, max: 5000 });
  assert.strictEqual(lookups.length, 0, 'refused before a single provider request');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [alice])).n, 0, 'nothing was changed');

  // At the cap, the lookups happen (outside the transaction), one per uncached card.
  const atCap = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, card_id: `mtg-uncached-${i}`, quantity: 1 }));
  r = await restore(base, file({ collection: [...atCap, { id: 9999, card_id: 'mtg-known-1', quantity: 1 }], sealed_purchases: [], sealed_units: [] }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.strictEqual(lookups.length, 5000, 'each uncached card is asked for once, the cached one not at all');
  assert.strictEqual(r.body.cards, 1, 'the cards no provider had are skipped, the known one restored');
  console.log('PASS: a member\'s restore looks up at most 5000 uncached cards');

  console.log('PASS: restoresecurity.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
