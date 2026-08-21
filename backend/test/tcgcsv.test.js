// Runnable checks for TCGCSV price matching (TCGplayer prices for Pokémon).
//
// Offline. Every fixture below was copied out of a live TCGCSV response while this
// was written, so the shapes are the real ones — but the tests never make a request,
// because the point is to pin the JOIN logic, and a network test would fail for
// reasons that have nothing to do with it.
//
// The join is where the danger is. A wrong set match does not fail loudly: it
// silently prices 102 Base Set cards off a 2023 release and every total in the app
// then quotes that number with a straight face. So the checks below are mostly about
// what the matcher must REFUSE.
//
// Measured on the real cache when written: 147 sets exact, 15 by name suffix, 11
// unmatched (102 cards) — and 629 of 633 owned-set cards priced, against 8% before.
//
// No framework — plain node + assert. Run: `node test/tcgcsv.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgcsv-${process.pid}.db`);
const tcgcsv = require('../src/tcgcsvApi');

// Real groups, verbatim from /tcgplayer/3/groups and /tcgplayer/85/groups.
const GROUPS_EN = [
  { groupId: 604, name: 'Base Set', abbreviation: 'BS', categoryId: 3 },
  { groupId: 1449, name: 'Gym Challenge', abbreviation: 'GC', categoryId: 3 },
  { groupId: 23237, name: 'SV: Scarlet & Violet 151', abbreviation: 'MEW', categoryId: 3 },
  { groupId: 22873, name: 'SV01: Scarlet & Violet Base Set', abbreviation: 'SVI', categoryId: 3 },
  { groupId: 3172, name: 'EX Delta Species', abbreviation: 'DS', categoryId: 3 },
  { groupId: 2999, name: 'XY - BREAKthrough', abbreviation: 'BKT', categoryId: 3 },
  { groupId: 17688, name: 'Pokemon GO', abbreviation: 'PGO', categoryId: 3 },
];
const GROUPS_JP = [
  { groupId: 24721, name: 'M6a: MEGA Expansion 30th Celebration', abbreviation: 'm6a', categoryId: 85 },
  { groupId: 23599, name: 'SV2a: Pokemon Card 151', abbreviation: 'SV2a', categoryId: 85 },
  // Abbreviations that collide with ENGLISH set ids. TCGdex calls the English
  // Diamond & Pearl base set 'dp1' and Black & White base 'bw1'; the Japanese
  // catalogue happens to abbreviate unrelated releases the same way.
  { groupId: 2306, name: 'DP1: Space-Time Creation', abbreviation: 'DP1', categoryId: 85 },
  { groupId: 2477, name: 'BW1: Black Collection', abbreviation: 'BW1', categoryId: 85 },
];

const match = tcgcsv.buildGroupMatcher({ 3: GROUPS_EN, 85: GROUPS_JP });

// --- 1. Exact keys ----------------------------------------------------------
// TCGdex names its sets plainly; TCGplayer prefixes them with a code. Either side's
// name, or the set id against the abbreviation, has to land.
assert.strictEqual(match('base1', 'Base Set', 'English').group.groupId, 604, 'name matches exactly');
assert.strictEqual(match('sv01', 'Scarlet & Violet', 'English').group.groupId, 22873,
  "'SV01: Scarlet & Violet Base Set' must reduce to 'Scarlet & Violet'");
assert.strictEqual(match('xy8', 'BREAKthrough', 'English').group.groupId, 2999,
  "the dash-separated code form ('XY - BREAKthrough') must reduce too");

// The diacritic case. TCGdex writes 'Pokémon GO', TCGplayer writes 'Pokemon GO'.
// Before folding, the accent was dropped as an illegal character rather than
// decomposed, giving 'pokmongo' vs 'pokemongo' — two keys for one set.
assert.strictEqual(match('swsh10.5', 'Pokémon GO', 'English').group.groupId, 17688,
  "'Pokémon GO' and 'Pokemon GO' are the same set");

// --- 2. Language picks the category ----------------------------------------
// '151' names a set in BOTH catalogues ('SV: Scarlet & Violet 151' and 'SV2a:
// Pokemon Card 151'). The card's own language has to decide, or an English
// collection is priced in the Japanese market and vice versa.
//
// Neither resolves exactly — '151' is not a key of either group — so both go
// through the suffix pass, which is scoped to the preferred catalogue. That scoping
// is the whole reason the suffix pass runs BEFORE the cross-catalogue exact pass.
assert.strictEqual(match('sv03.5', '151', 'English').categoryId, 3, 'English 151 -> category 3');
assert.strictEqual(match('sv03.5', '151', 'English').group.groupId, 23237);
assert.strictEqual(match('sv2a', '151', 'Japanese').categoryId, 85, 'Japanese 151 -> category 85');
assert.strictEqual(match('sv2a', '151', 'Japanese').group.groupId, 23599);

// --- 3. The suffix pass, and what it must refuse --------------------------
// TCGplayer prepends the era to older set names, which no exact key recovers.
const delta = match('ex11', 'Delta Species', 'English');
assert.strictEqual(delta.group.groupId, 3172, "'Delta Species' -> 'EX Delta Species'");
assert.strictEqual(delta.confidence, 0.8, 'a suffix match must be marked as less certain');

// THE one that matters. 'Base Set' is a genuine suffix of 'SV01: Scarlet & Violet
// Base Set'. If the suffix pass ran before the exact pass, or ignored ambiguity,
// every Base Set card would be priced off a 2023 release — a wrong number that
// looks entirely plausible in the UI.
assert.strictEqual(match('base1', 'Base Set', 'English').confidence, 1,
  'Base Set must resolve EXACTLY, never by suffix');

// An unknown set is null, not a guess. No match leaves the existing price alone;
// a wrong match overwrites it.
assert.strictEqual(match('unknown_set_123', 'Some Random Unknown Set', 'English'), null,
  'an unmatched set must return null rather than a near-miss');

// Aliases and '&' / 'and' matching when the proper English groups are present.
const matchExtended = tcgcsv.buildGroupMatcher({
  3: [
    ...GROUPS_EN,
    { groupId: 1418, name: 'WoTC Promo', abbreviation: 'PR', categoryId: 3 },
    { groupId: 1430, name: 'Diamond and Pearl', abbreviation: 'DP', categoryId: 3 },
    { groupId: 1400, name: 'Black and White', abbreviation: 'BLW', categoryId: 3 },
    { groupId: 1863, name: 'SM Base Set', abbreviation: 'SM01', categoryId: 3 },
  ],
  85: GROUPS_JP,
});
assert.strictEqual(matchExtended('basep', 'Wizards Black Star Promos', 'English').group.groupId, 1418,
  "'basep' / 'Wizards Black Star Promos' must match 'WoTC Promo'");
assert.strictEqual(matchExtended('dp1', 'Diamond & Pearl', 'English').group.groupId, 1430,
  "'dp1' / 'Diamond & Pearl' must match 'Diamond and Pearl' in English catalogue");
assert.strictEqual(matchExtended('bw1', 'Black & White', 'English').group.groupId, 1400,
  "'bw1' / 'Black & White' must match 'Black and White' in English catalogue");
assert.strictEqual(matchExtended('sm1', 'Sun & Moon', 'English').group.groupId, 1863,
  "'sm1' / 'Sun & Moon' must match 'SM Base Set' in English catalogue");

// --- 3b. Set IDS collide across catalogues too ------------------------------
// The suffix pass is scoped to the preferred catalogue, but the cross-catalogue
// EXACT pass was not — and it matches on abbreviation as well as name. English
// 'dp1' is an exact key of the Japanese group 'DP1: Space-Time Creation', so
// Diamond & Pearl scored 0.9 against a Japanese release and would have been both
// priced and, once the scanner joins on product id, IDENTIFIED off it.
//
// Measured on the real cache: six sets matched this way (dp1, bw1, xyp, dpp,
// Sun & Moon, and a Japanese starter set). Refusing them moved 43 cards from
// confidently wrong to honestly unmatched, which is the trade this file exists
// to make.
assert.strictEqual(match('dp1', 'Diamond & Pearl', 'English'), null,
  "English 'dp1' must NOT match the Japanese group abbreviated DP1");
assert.strictEqual(match('bw1', 'Black & White', 'English'), null,
  "English 'bw1' must NOT match the Japanese group abbreviated BW1");

// The reverse direction is equally wrong: a Japanese set must not fall into the
// English catalogue on an id collision.
assert.strictEqual(match('bs', 'なんとか', 'Japanese'), null,
  'a Japanese set must not match the English Base Set abbreviation');

// The escape hatch still works for the case it was written for: a language
// TCGplayer files under neither catalogue cleanly. German cards guess English,
// and when that guess is wrong the cross-catalogue pass is still allowed.
assert.strictEqual(match('sv2a', 'Pokemon Card 151', 'German').group.groupId, 23599,
  'a non-English/Japanese language may still cross catalogues on an exact key');

// --- 4. Pocket sets are skipped, not failed ------------------------------
// Cards that exist only in the phone game. TCGplayer has never sold one, so they
// are not misses to be fixed — and counting them as misses hides the real ones.
for (const id of ['A1', 'A1a', 'A2b', 'B1', 'b2']) {
  assert.ok(tcgcsv.isPocketSet(id), `${id} is a Pocket set`);
}
for (const id of ['base1', 'sv01', 'swsh10.5', 'me01', 'neo2', 'ex11']) {
  assert.ok(!tcgcsv.isPocketSet(id), `${id} is a real set`);
}

// --- 5. Card numbers -----------------------------------------------------
// TCGplayer writes '004/102' where TCGdex writes '4'.
assert.strictEqual(tcgcsv.normNumber('004/102'), '4');
assert.strictEqual(tcgcsv.normNumber('4'), '4');
assert.strictEqual(tcgcsv.normNumber('  012/165 '), '12');
// Letters are KEPT. 'TG12' and 'SWSH284' are card numbers; stripping their letters
// would collapse every promo in a set onto one key and then drop them all as
// ambiguous.
assert.strictEqual(tcgcsv.normNumber('TG12/TG30'), 'tg12');
assert.strictEqual(tcgcsv.normNumber('SWSH284'), 'swsh284');
// Zero-stripping must not eat a lone zero or a letter's leading digit.
assert.strictEqual(tcgcsv.normNumber('0'), '0');
assert.strictEqual(tcgcsv.normNumber(''), '');
assert.strictEqual(tcgcsv.normNumber(null), '');

// --- 6. Prices land in the right columns --------------------------------
// Real price rows. Modern sets use Normal/Holofoil/Reverse Holofoil; vintage sets
// use 1st Edition/Unlimited and the Holofoil variants of both.
const modern = tcgcsv.pricesByProduct([
  { productId: 1, subTypeName: 'Normal', marketPrice: 1.5, midPrice: 2 },
  { productId: 1, subTypeName: 'Holofoil', marketPrice: 12.0, midPrice: 15 },
  { productId: 1, subTypeName: 'Reverse Holofoil', marketPrice: 4.25, midPrice: 5 },
]).get(1);
assert.deepStrictEqual(
  [modern.price_normal, modern.price_holofoil, modern.price_reverse_holofoil, modern.price_1st_edition],
  [1.5, 12.0, 4.25, null]
);
assert.strictEqual(modern.price_trend, 12.0, 'trend prefers holofoil — the card people mean');

// The bug this column exists to fix. Blaine's Charizard: 1st Edition Holofoil
// $699.99, Unlimited Holofoil $597.59. Folding 1st Edition into price_normal put
// $699.99 there, so the 'Normal' printing displayed a 1st Edition HOLO's price —
// above the holofoil column, which is how it was spotted.
const vintage = tcgcsv.pricesByProduct([
  { productId: 2, subTypeName: '1st Edition Holofoil', marketPrice: 699.99, midPrice: 720 },
  { productId: 2, subTypeName: 'Unlimited Holofoil', marketPrice: 597.59, midPrice: 610 },
]).get(2);
assert.strictEqual(vintage.price_holofoil, 597.59, 'Unlimited holo is the holofoil price');
assert.strictEqual(vintage.price_1st_edition, 699.99, '1st Edition holo gets its own column');
assert.strictEqual(vintage.price_normal, null, 'a 1st Edition price must never sit in price_normal');
assert.strictEqual(vintage.price_trend, 597.59, 'trend is the Unlimited price, not the 1st Edition premium');

// A non-holo vintage common carries only the two plain names.
const common = tcgcsv.pricesByProduct([
  { productId: 3, subTypeName: '1st Edition', marketPrice: 8.0 },
  { productId: 3, subTypeName: 'Unlimited', marketPrice: 2.0 },
]).get(3);
assert.strictEqual(common.price_normal, 2.0, 'Unlimited is the normal price');
assert.strictEqual(common.price_1st_edition, 8.0);
assert.strictEqual(common.price_trend, 2.0, 'trend must not quote the 1st Edition premium');

// marketPrice is TCGplayer's computed value from real sales; midPrice is the
// midpoint of what sellers are ASKING and runs high, so it is only a fallback.
const noMarket = tcgcsv.pricesByProduct([
  { productId: 4, subTypeName: 'Holofoil', marketPrice: 0, midPrice: 9.99 },
]).get(4);
assert.strictEqual(noMarket.price_holofoil, 9.99, 'midPrice covers a product with no market price');

// An unrecognised finish is dropped, not guessed at. A wrong number presented as a
// right one is worse than a blank.
assert.strictEqual(tcgcsv.pricesByProduct([
  { productId: 5, subTypeName: 'Some New Finish', marketPrice: 5 },
]).size, 0, 'an unmapped finish must produce no row at all');

// --- 7. extendedData reading -------------------------------------------
// Verbatim from the Base Set Charizard product.
assert.strictEqual(tcgcsv.numberOf({
  extendedData: [
    { name: 'Number', displayName: 'Card Number', value: '004/102' },
    { name: 'Rarity', displayName: 'Rarity', value: 'Holo Rare' },
  ],
}), '004/102');
assert.strictEqual(tcgcsv.numberOf({ extendedData: [] }), null);
assert.strictEqual(tcgcsv.numberOf({}), null);

// --- 8. Language -> category --------------------------------------------
// Every non-Japanese language TCGdex carries is a Western release, so it belongs to
// TCGplayer's Pokemon category rather than Pokemon Japan.
assert.strictEqual(tcgcsv.categoryFor('Japanese'), 85);
assert.strictEqual(tcgcsv.categoryFor('English'), 3);
assert.strictEqual(tcgcsv.categoryFor('German'), 3);
assert.strictEqual(tcgcsv.categoryFor(undefined), 3);

// --- 9. The sweep gate must actually know about tcgcsv -------------------
// This one shipped broken and said nothing. shouldSweepPrices returns FALSE for an
// unknown provider key, so a missing SWEEP_COLUMN entry makes the boot catch-up
// skip ('already swept within the last 24h' — for a column that did not exist) and
// makes markPricesSwept a no-op. Nothing errors; the price source is just dead.
//
// Caught only by booting the server and reading the log, which is why it is pinned
// here: every provider in server.js needs a column, and the failure is silent.
const { PRICE_SWEEP_INTERVAL_MS } = require('../src/utils/priceHelpers');
const dbMod = require('../src/db');

(async () => {
  await dbMod.initDb();
  const cols = (await dbMod.all(`PRAGMA table_info(app_settings)`)).map(c => c.name);
  for (const provider of ['mtg', 'pokemon', 'tcgdex', 'tcgcsv']) {
    assert.ok(cols.includes(`${provider}_prices_swept_at`),
      `app_settings needs ${provider}_prices_swept_at`);
  }

  const { shouldSweepPrices, markPricesSwept } = require('../src/utils/priceHelpers');
  // A provider that has never swept must sweep.
  await dbMod.run(`UPDATE app_settings SET tcgcsv_prices_swept_at = NULL WHERE id = 1`);
  assert.strictEqual(await shouldSweepPrices('tcgcsv'), true,
    'a never-swept provider must sweep — this is what the missing column broke');

  // And once marked, it must hold off. Without a real column the mark was silently
  // dropped and this would have stayed true forever.
  await markPricesSwept('tcgcsv');
  assert.strictEqual(await shouldSweepPrices('tcgcsv'), false,
    'markPricesSwept must actually record, not no-op');

  // The gate is a day wide, matching TCGCSV's own once-daily mirror.
  assert.strictEqual(PRICE_SWEEP_INTERVAL_MS, 1000 * 60 * 60 * 24);

  // An unknown provider still refuses, which is the safe direction for a typo —
  // but only because every real provider is asserted above.
  assert.strictEqual(await shouldSweepPrices('nope'), false);

  console.log('tcgcsv self-check passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
