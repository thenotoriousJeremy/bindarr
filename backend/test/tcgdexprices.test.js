// One TCGdex card, one marketplace, one currency (PROV-06).
//
// TCGdex can carry a TCGplayer block and a Cardmarket block for the same card.
// Each finish used to fall back from one to the other on its own and the row was
// then labelled with a single currency, so a card came out with a €0.50 normal and
// a €1.20 reverse next to a $4.97 holo, all marked USD. Now TCGplayer prices the
// whole row when it quotes any finish, else Cardmarket does, which is the rule the
// Scryfall and pokemontcgapi clients already follow.
// Run: `node test/tcgdexprices.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-tcgdexprices-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../src/db');
const { normalizeCard } = require('../src/tcgdexApi');
process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
});

const card = (pricing) => normalizeCard({
  id: 'sv03-004', localId: '004', name: 'Charizard ex', category: 'Pokemon', set: { id: 'sv03', name: 'Obsidian Flames' },
  pricing,
}, 'en');

// Both marketplaces quote: TCGplayer prices the whole row.
const mixed = card({
  tcgplayer: { holofoil: { marketPrice: 4.97 } },
  cardmarket: { avg: 0.5, 'avg-reverse': 1.2, avg1: 0.6, avg7: 0.55, avg30: 0.52 },
});
assert.strictEqual(mixed.price_currency, 'USD');
assert.strictEqual(mixed.price_holofoil, 4.97);
assert.strictEqual(mixed.price_normal, null, 'no euro price beside a dollar one');
assert.strictEqual(mixed.price_reverse_holofoil, null, 'no euro reverse either');
assert.strictEqual(mixed.price_trend, 4.97);
// Cardmarket's rolling averages are their own series and stay.
assert.strictEqual(mixed.price_avg30, 0.52);

// A reverse-only TCGplayer quote still counts as TCGplayer answering.
const reverseOnly = card({ tcgplayer: { reverseHolofoil: { midPrice: 2 } }, cardmarket: { avg: 0.5 } });
assert.strictEqual(reverseOnly.price_currency, 'USD');
assert.strictEqual(reverseOnly.price_reverse_holofoil, 2);
assert.strictEqual(reverseOnly.price_normal, null);

// Cardmarket alone: every finish from it, in euros.
const euro = card({ cardmarket: { avg: 0.5, 'avg-holo': 3, trend: 0.7 } });
assert.strictEqual(euro.price_currency, 'EUR');
assert.strictEqual(euro.price_normal, 0.5);
assert.strictEqual(euro.price_holofoil, 3);
assert.strictEqual(euro.price_trend, 0.5);

// Nothing quoted: a zero trend, no finish prices.
const none = card({});
assert.strictEqual(none.price_trend, 0);
assert.strictEqual(none.price_normal, null);

console.log('tcgdexprices.test.js: all assertions passed');
db.dbConnection.close(() => {});
