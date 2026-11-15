// Small costs on paths every user hits, each pinned by what SQLite does:
//
//   - a page of the collection list (newest first) reads an index in order instead
//     of sorting the whole collection for every page;
//   - deleting a copy reads the schema's foreign keys once, not every time (it was
//     some 40 statements for one card);
//   - the boot-time backfill of the product map's NULL games looks those rows up
//     instead of scanning the whole catalog on every start.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-hotpaths-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const db = require('../src/db');
const { trashEntries } = require('../src/utils/collectionTrash');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const plan = async (sql, params) => (await db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map(r => r.detail);

async function collectionPage() {
  const steps = await plan(`
    SELECT c.id FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN sealed_units su ON su.id = c.sealed_unit_id
     WHERE c.user_id = ? AND c.list_type = ?
     ORDER BY c.added_at DESC, c.id DESC LIMIT ? OFFSET ?`, [1, 'collection', 50, 0]);
  assert.ok(steps.some(s => /idx_collection_user_list_added/.test(s)), `a collection page reads the list index: ${steps.join(' | ')}`);
  assert.ok(!steps.some(s => /TEMP B-TREE FOR ORDER BY/.test(s)), `and needs no sort: ${steps.join(' | ')}`);
  console.log('PASS: a collection page is read in index order');
}

async function trashSchemaWalk() {
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('trasher', 'x', 'admin', 'tok')`)).lastID;
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('t1', 'Trash Me', 'pokemon')`);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES ('t1', ?, 'pokemon')`, [userId])).lastID);

  const fkReads = { n: 0 };
  const realAll = db.all;
  db.all = (sql, ...rest) => { if (/foreign_key_list/.test(sql)) fkReads.n++; return realAll(sql, ...rest); };
  try {
    await trashEntries([ids[0]], userId);
    const first = fkReads.n;
    assert.ok(first > 0, 'the first delete reads the schema');
    await trashEntries([ids[1]], userId);
    await trashEntries([ids[2]], userId);
    assert.strictEqual(fkReads.n, first, 'later deletes reuse it');
  } finally {
    db.all = realAll;
  }
  // A schema change is noticed: a new table that references collection(id) is
  // covered by the next delete.
  await db.run(`CREATE TABLE trash_probe (entry_id INTEGER REFERENCES collection(id) ON DELETE CASCADE, note TEXT)`);
  const fresh = (await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES ('t1', ?, 'pokemon')`, [userId])).lastID;
  await db.run(`INSERT INTO trash_probe (entry_id, note) VALUES (?, 'kept')`, [fresh]);
  await trashEntries([fresh], userId);
  const stored = await db.get(`SELECT links_json FROM collection_trash WHERE entry_id = ?`, [fresh]);
  assert.ok(stored.links_json && JSON.parse(stored.links_json).trash_probe, 'a table added since is still snapshotted with the copy');
  console.log('PASS: deletes read the schema once, and notice when it changes');
}

async function catalogBackfill() {
  const steps = await plan(`UPDATE tcgplayer_catalog SET game = 'pokemon' WHERE game IS NULL AND category_id IN (3, 85)`, []);
  assert.ok(steps.some(s => /idx_tcgplayer_catalog_no_game/.test(s)), `the boot backfill looks rows up: ${steps.join(' | ')}`);
  assert.ok(!steps.some(s => /^SCAN tcgplayer_catalog/.test(s)), 'instead of scanning the catalog');
  console.log('PASS: the product-map game backfill reads only the rows it can fix');
}

async function main() {
  await db.initDb();
  await collectionPage();
  await trashSchemaWalk();
  await catalogBackfill();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
