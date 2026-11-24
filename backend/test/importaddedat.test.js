// An import keeps the date a copy was added when the file says it (Bindarr's own
// CSV and JSON exports do), read the way an edit reads one (readAddedAt, #196).
// A file without one, or a cell that is not a date, stamps the copy with the
// import's time, as every import used to; the bad cells are counted in the summary.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-importaddedat-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const { parseThirdPartyCSV } = require('../src/utils/csvMappers');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(userId) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/importExport'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function call(base, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* a CSV export */ }
  return { status: res.status, body: parsed };
}

const datesOf = async (cardId) => (await db.all(`SELECT added_at FROM collection WHERE card_id = ? ORDER BY id`, [cardId])).map(r => r.added_at);
// CURRENT_TIMESTAMP's form, to the minute: "now" as the import writes it.
const recent = (stamp) => Math.abs(Date.parse(`${stamp.replace(' ', 'T')}Z`) - Date.now()) < 5 * 60 * 1000;

async function main() {
  // --- the CSV mapper reads the column by any of its spellings -------------------
  const [own] = parseThirdPartyCSV([{ 'Card ID': 'mtg-a', 'Added At': '2021-04-23 10:15:00' }], 'internal');
  assert.strictEqual(own.added_at, '2021-04-23 10:15:00', "Bindarr's own export header");
  const [other] = parseThirdPartyCSV([{ Name: 'Sol Ring', 'Date Added': '2020-01-02' }], 'csv');
  assert.strictEqual(other.added_at, '2020-01-02');
  const [none] = parseThirdPartyCSV([{ Name: 'Sol Ring' }], 'csv');
  assert.strictEqual(none.added_at, undefined, 'no column, no date');

  // --- the import ------------------------------------------------------------------
  scryfallApi.client.get = async (url) => { throw new Error(`no network in this test (${url})`); };
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('owner', 'x', 'admin', 'tok')`)).lastID;
  for (const id of ['mtg-a', 'mtg-b', 'mtg-c', 'mtg-d']) {
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES (?, ?, 'mtg', 'English', 1)`, [id, id]);
  }
  const base = await startApp(userId);

  // JSON (GET /collection's rows, or a Bindarr JSON export): every copy of a row
  // gets its date; an ISO instant with an offset is stored as UTC.
  let res = await call(base, 'POST', '/api/import', {
    format: 'json',
    data: [
      { card_id: 'mtg-a', quantity: 2, game: 'mtg', added_at: '2021-04-23 10:15:00' },
      { card_id: 'mtg-b', quantity: 1, game: 'mtg', added_at: '2022-06-01T12:00:00+02:00' },
      { card_id: 'mtg-c', quantity: 1, game: 'mtg', added_at: '2023-02-30' },
      { card_id: 'mtg-d', quantity: 1, game: 'mtg' },
    ]
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 5);
  assert.deepStrictEqual(await datesOf('mtg-a'), ['2021-04-23 10:15:00', '2021-04-23 10:15:00']);
  assert.deepStrictEqual(await datesOf('mtg-b'), ['2022-06-01 10:00:00'], 'stored as UTC');
  const [bad] = await datesOf('mtg-c');
  assert.ok(recent(bad), `February 30th is not a date, so the copy is dated now (${bad})`);
  const [undated] = await datesOf('mtg-d');
  assert.ok(recent(undated), `a row with no date is dated now (${undated})`);
  assert.strictEqual(res.body.undated, 1, 'only the bad cell is counted, not the missing one');
  assert.match(res.body.message, /1 row had a date added that is not a date \(or is in the future\) and was dated today/);

  // A date in the future is refused the same way.
  await db.run(`DELETE FROM collection`);
  res = await call(base, 'POST', '/api/import', {
    format: 'json', data: [{ card_id: 'mtg-a', quantity: 1, game: 'mtg', added_at: '2999-01-01' }]
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.undated, 1);
  assert.ok(recent((await datesOf('mtg-a'))[0]));

  // --- a Bindarr CSV export imports back with its dates ------------------------------
  await db.run(`DELETE FROM collection`);
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, game, added_at)
     VALUES ('mtg-a', ?, 1, 'Near Mint', 'Normal', 'English', 0, 'mtg', '2019-07-04 08:30:00'),
            ('mtg-b', ?, 1, 'Lightly Played', 'Holofoil', 'English', 2.5, 'mtg', '2020-12-25 23:59:59')`,
    [userId, userId]
  );
  const exported = await call(base, 'GET', '/api/export?format=csv');
  assert.strictEqual(exported.status, 200);
  assert.match(exported.body, /Added At/, 'the export carries the column');
  await db.run(`DELETE FROM collection`);
  res = await call(base, 'POST', '/api/import', { format: 'csv', data: exported.body });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 2, JSON.stringify(res.body));
  assert.deepStrictEqual(await datesOf('mtg-a'), ['2019-07-04 08:30:00'], 'round trip keeps the date');
  assert.deepStrictEqual(await datesOf('mtg-b'), ['2020-12-25 23:59:59']);
  assert.strictEqual(res.body.undated, 0);

  console.log('importaddedat ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
