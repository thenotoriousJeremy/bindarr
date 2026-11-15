// pokemontcgapi.com kept up to 1,024 whole API responses in the main database,
// bounded by count alone. It is bounded by size as well, newest kept first
// (PROV-17).
// Run: `node test/scanoverhead.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scanoverhead-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const pokemontcgapi = require('../src/pokemontcgapi');

async function main() {
  await db.initDb();

  // The response cache is bounded by size.
  const big = 'x'.repeat(5 * 1024 * 1024);   // a 5 MiB response
  for (let i = 0; i < 20; i++) {
    await db.run(`INSERT INTO pokemontcgapi_cache (request, body, etag, fetched_at) VALUES (?, ?, NULL, ?)`,
      [`r${i}`, JSON.stringify({ data: big }), 1000 + i]);
  }
  await pokemontcgapi.trimResponseCache({ force: true });
  const kept = await db.all(`SELECT request FROM pokemontcgapi_cache ORDER BY fetched_at DESC`);
  const bytes = (await db.get(`SELECT SUM(LENGTH(body)) AS b FROM pokemontcgapi_cache`)).b;
  assert.ok(bytes <= pokemontcgapi.MAX_CACHED_BYTES, `${bytes} bytes kept, within ${pokemontcgapi.MAX_CACHED_BYTES}`);
  assert.strictEqual(kept[0].request, 'r19', 'the newest response is kept');
  assert.ok(kept.length >= 10 && kept.length < 20, `the oldest went first (${kept.length} kept)`);
  assert.ok(!kept.some(r => r.request === 'r0'), 'the oldest is gone');

  // A single response over the bound is still kept: it is the one just asked for.
  await db.run(`DELETE FROM pokemontcgapi_cache`);
  await db.run(`INSERT INTO pokemontcgapi_cache (request, body, etag, fetched_at) VALUES ('huge', ?, NULL, 1)`,
    ['y'.repeat(pokemontcgapi.MAX_CACHED_BYTES + 10)]);
  await pokemontcgapi.trimResponseCache({ force: true });
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM pokemontcgapi_cache`)).n, 1);

  console.log('scanoverhead.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
