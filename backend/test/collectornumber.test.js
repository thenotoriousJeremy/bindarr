// One rule for comparing collector numbers (PROV-19).
//
// Eight modules each normalized card numbers their own way: one kept zeros after a
// letter, one stripped every symbol, one took '4a' for card 4 through parseInt,
// one compared raw strings. The same pair of numbers matched in one place and not
// in the next. setCatalogueMatch.numberKey is the rule now, and the modules that
// compare numbers use it — this pins both the rule and that they do.
// Run: `node test/collectornumber.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-collectornumber-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../src/db');
const { numberKey, sameNumber, normName } = require('../src/utils/setCatalogueMatch');
process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
});

// The same card, written the ways the providers write it.
for (const [a, b] of [
  ['004/165', '4'], ['004', '4'], ['#4', '4'], [' 4 / 102 ', '4'],
  ['TG01', 'TG1'], ['SV001', 'sv1'], ['SWSH050', 'swsh50'], ['GG01', 'gg1'], ['TG12/TG30', 'tg12'],
  ['15_A1', '15A1'], ['XY121a', 'XY0121A'], ['0', '00'],
]) {
  assert.ok(sameNumber(a, b), `${a} ~ ${b}`);
}
// Different cards, which a looser rule merged.
for (const [a, b] of [
  ['28a', '28'], ['4a', '4'], ['TG12', 'SV12'], ['10', '1'], ['100', '10'], ['TG10', 'TG1'], ['13', '130'], ['?', '!'],
]) {
  assert.ok(!sameNumber(a, b), `${a} !~ ${b}`);
}
// A blank names no card.
assert.ok(!sameNumber('', ''));
assert.ok(!sameNumber(null, undefined));
assert.strictEqual(numberKey('004/102'), '4');
assert.strictEqual(numberKey('SWSH284'), 'swsh284');
assert.strictEqual(numberKey(null), '');

// Every module that compares numbers compares them this way.
assert.strictEqual(require('../src/tcgcsvApi').normNumber, numberKey, 'tcgcsvApi');
assert.strictEqual(require('../src/gradedPrices').normalizeNumber, numberKey, 'gradedPrices');
assert.strictEqual(require('../src/utils/pokemonIdMap').numKey, numberKey, 'pokemonIdMap');
assert.strictEqual(require('../src/scanCandidates').sameNumber, sameNumber, 'scanCandidates');

// Names fold accents before dropping what is not a-z0-9: the copy tcgplayerCatalog
// kept did not, so 'Pokémon GO' and 'Pokemon GO' were two keys.
assert.strictEqual(normName('Pokémon GO'), normName('Pokemon GO'));

console.log('collectornumber.test.js: all assertions passed');
db.dbConnection.close(() => {});
