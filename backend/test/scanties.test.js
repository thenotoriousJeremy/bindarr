// Ties between reprints that share their art (PROV-10), and a Lorcana match that
// is refused rather than guessed (PROV-21).
//
// Printings of one illustration embed to near-identical vectors, so between them
// the cosine order was noise and exact-printing accuracy sat near 76%. When the
// card is clear (top score >= STRONG_SIM) and others of the same artwork are
// within STRONG_MARGIN, scanCandidates.breakPrintingTies puts the owned printing
// first, then the scanned language, then the newest set, and flags the result
// `ambiguousPrinting` so the client can offer the alternatives.
// Run: `node test/scanties.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scanties-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const sc = require('../src/scanCandidates');
const cvScan = require('../src/cvScan');
const tcgplayerCatalog = require('../src/tcgplayerCatalog');
const lorcastApi = require('../src/lorcastApi');

const opts = { game: 'mtg', langName: 'English', userId: 1, strongSim: cvScan.STRONG_SIM, strongMargin: cvScan.STRONG_MARGIN };
const cand = (id, score, card) => ({ cardId: id, score, card: { id, name: 'Lightning Bolt', language: 'English', ...card } });

async function main() {
  await db.initDb();
  for (const [code, date] of [['lea', '1993-08-05'], ['m10', '2009-07-17'], ['clb', '2022-06-10'], ['sta', '2021-04-23']]) {
    await db.run(`INSERT INTO sets (id, name, release_date, game) VALUES (?, ?, ?, 'mtg')`, [`mtg-${code}`, code, date]);
  }
  await db.run(`INSERT INTO card_cache (id, name, set_id, number, game) VALUES ('mtg-m10', 'Lightning Bolt', 'm10', '146', 'mtg')`);
  await db.run(`INSERT INTO collection (user_id, card_id, quantity, game) VALUES (1, 'mtg-m10', 1, 'mtg')`);

  // 1. The owned printing first, then the scanned language, then the newest.
  const A = cand('mtg-lea', 0.80, { oracle_id: 'bolt', set_id: 'lea' });
  const B = cand('mtg-m10', 0.79, { oracle_id: 'bolt', set_id: 'm10' });          // owned
  const C = cand('mtg-clb-ja', 0.785, { oracle_id: 'bolt', set_id: 'clb', language: 'Japanese' });
  const E = cand('mtg-sta', 0.78, { oracle_id: 'bolt', set_id: 'sta' });          // newer than lea
  const D = cand('mtg-other', 0.775, { oracle_id: 'shock', name: 'Shock', set_id: 'm10' });
  const far = cand('mtg-old', 0.70, { oracle_id: 'bolt', set_id: 'lea' });       // same art, outside the margin
  let r = await sc.breakPrintingTies([A, B, C, E, D, far], opts);
  assert.strictEqual(r.ambiguousPrinting, true);
  assert.deepStrictEqual(r.candidates.map(c => c.cardId), ['mtg-m10', 'mtg-sta', 'mtg-lea', 'mtg-clb-ja', 'mtg-other', 'mtg-old'],
    'owned, then English newest first, then the other language; other art and far scores keep their order');
  assert.deepStrictEqual(r.candidates.map(c => c.score), [0.79, 0.78, 0.80, 0.785, 0.775, 0.70], 'scores are untouched');

  // 2. Another user's collection is not this user's.
  r = await sc.breakPrintingTies([A, B], { ...opts, userId: 2 });
  assert.deepStrictEqual(r.candidates.map(c => c.cardId), ['mtg-m10', 'mtg-lea'], 'newest first when nothing is owned');

  // 3. Different art within the margin is a different card: nothing to break.
  r = await sc.breakPrintingTies([A, D], opts);
  assert.deepStrictEqual(r, { candidates: [A, D], ambiguousPrinting: false });

  // 4. An unsure identification is left exactly as ranked.
  const weak = [cand('mtg-lea', 0.40, { oracle_id: 'bolt', set_id: 'lea' }), cand('mtg-m10', 0.39, { oracle_id: 'bolt', set_id: 'm10' })];
  r = await sc.breakPrintingTies(weak, opts);
  assert.deepStrictEqual(r, { candidates: weak, ambiguousPrinting: false });

  // 5. Pokémon has no oracle id: the name stands in for the artwork.
  const pk = (id, score, set_id) => ({ cardId: id, score, card: { id, name: 'Pikachu', set_id, language: 'English' } });
  await db.run(`INSERT INTO sets (id, name, release_date, game) VALUES ('base1', 'Base', '1999/01/09', 'pokemon'), ('cel25', 'Celebrations', '2021/10/08', 'pokemon')`);
  r = await sc.breakPrintingTies([pk('base1-58', 0.9, 'base1'), pk('cel25-5', 0.89, 'cel25')], { ...opts, game: 'pokemon' });
  assert.strictEqual(r.ambiguousPrinting, true);
  assert.deepStrictEqual(r.candidates.map(c => c.cardId), ['cel25-5', 'base1-58']);

  // 6. Nothing to rank.
  assert.deepStrictEqual(await sc.breakPrintingTies([], opts), { candidates: [], ambiguousPrinting: false });

  // --- PROV-21: a Lorcana product id is named by its number, never by a guess ------
  tcgplayerCatalog.lookup = async () => ({ name: 'Mickey Mouse', set_id: '2', number: '5' });
  lorcastApi.searchCards = async () => ({ cards: [{ id: 'lorcana-crd_wrong', name: 'Mickey Mouse', number: '7', set_id: 'lorcana-2' }] });
  const refused = await sc.resolveCandidate({ productId: 5050 }, 0, { game: 'lorcana', langName: 'English', tcgApiKey: '' });
  assert.strictEqual(refused.card, undefined, 'a result with another number is not taken for the card');
  assert.strictEqual(refused.name, 'Mickey Mouse', 'the catalogue hint still names it');
  assert.strictEqual(await db.get(`SELECT * FROM tcgplayer_product WHERE product_id = 5050`), undefined,
    'and no mapping is remembered for a guess');

  console.log('scanties.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
