// The pokemontcg.io card-id migration end to end, over a temporary database:
// preview, apply, re-run, revert — through the real admin router (sessions,
// requireAdmin), the real backup module and the real provider clients, with
// TCGdex answered from test/fixtures/pokemonmigration and every other request
// failing the test. The install starts pinned to pokemontcg.io, the way db.js
// leaves an upgraded one, so apply also switches the provider and revert puts it
// back.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Own directory: backups, uploaded card art and the scan catalog all live beside
// the database, and none of them may land in the shared temp root.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-pokemonmigration-${process.pid}-`));
process.env.DB_PATH = path.join(tmpDir, 'bindarr.db');
process.env.CV_MODEL_DIR = path.join(tmpDir, 'models');
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const axios = require('axios');
axios.defaults.adapter = async (config) => { throw new Error(`Unexpected network request: ${config.url}`); };
const express = require('express');
const db = require('../src/db');
const tcgApi = require('../src/tcgApi');
const tcgdexApi = require('../src/tcgdexApi');
const tcgcsvApi = require('../src/tcgcsvApi');
const cardArt = require('../src/cardArt');
const tcgplayerCatalog = require('../src/tcgplayerCatalog');
const migration = require('../src/pokemonMigration');
const fixture = require('./fixtures/pokemonmigration/tcgdex-en.json');
const legacy = require('./fixtures/pokemonmigration/pokemontcgio-cards.json');

// --- provider HTTP, from fixtures -----------------------------------------------
const briefs = new Map();
for (const d of Object.values(fixture.details)) for (const c of d.cards) briefs.set(c.id, { ...c, set: { id: d.id, name: d.name } });
const failing = new Set(['swsh9tg-TG01']); // its card details fail on the first pass
const tcgdexCalls = [];
const respond = (config, status, data) => {
  if (status === 200) return { status, statusText: 'OK', headers: {}, config, data };
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data, headers: {}, config };
  error.config = config;
  throw error;
};
tcgdexApi.client.defaults.adapter = async (config) => {
  const url = decodeURIComponent(config.url);
  tcgdexCalls.push(url);
  if (url === '/en/sets') return respond(config, 200, fixture.sets);
  let m = url.match(/^\/en\/sets\/(.+)$/);
  if (m) return fixture.details[m[1]] ? respond(config, 200, fixture.details[m[1]]) : respond(config, 404, {});
  m = url.match(/^\/en\/cards\/(.+)$/);
  if (m) {
    if (failing.has(m[1])) return respond(config, 503, {});
    if (fixture.cards[m[1]]) return respond(config, 200, fixture.cards[m[1]]);
    const brief = briefs.get(m[1]);
    if (!brief) return respond(config, 404, {});
    return respond(config, 200, { ...brief, category: 'Pokemon', rarity: 'Rare', types: ['Colorless'], stage: 'Basic',
      pricing: { cardmarket: { avg: 1.5, trend: 1.4 } } });
  }
  return respond(config, 404, {}); // /en/series: the set sync copes without it
};
// Undo switches back to pokemontcg.io, whose set sync then asks for /sets.
tcgApi.tcgClient.defaults.adapter = async (config) => {
  if (config.url === '/sets') return respond(config, 200, { data: [] });
  throw new Error(`Unexpected pokemontcg.io request: ${config.url}`);
};
tcgcsvApi.client.defaults.adapter = async (config) => { throw new Error(`Unexpected TCGCSV request: ${config.url}`); };

// --- the install -------------------------------------------------------------------
const MOVED = {
  'base1-4': 'tcgdex-en-base1-4', 'base1-58': 'tcgdex-en-base1-58', 'sv1-1': 'tcgdex-en-sv01-001',
  'sv3pt5-25': 'tcgdex-en-sv03.5-025', 'sv3pt5-6': 'tcgdex-en-sv03.5-006', 'swshp-SWSH050': 'tcgdex-en-swshp-SWSH050',
  'swsh9tg-TG01': 'tcgdex-en-swsh9tg-TG01', 'swsh12pt5gg-GG01': 'tcgdex-en-swsh12.5-GG01', 'pgo-11': 'tcgdex-en-swsh10.5-011',
  'xyp-XY121a': 'tcgdex-en-xyp-XY121a', 'sma-SV2': 'tcgdex-en-sma-SV02', 'fut20-5': 'tcgdex-en-fut2020-5',
};
const LEFT = ['mcd14-1', 'sma-SV1', 'sv1-3', 'sv1-999', 'sv2-11', 'sv4-1'];
const json = (v) => JSON.stringify(v);
const catalogFile = path.join(process.env.CV_MODEL_DIR, 'milo-pokemon-local.json');
const catalogIds = () => JSON.parse(fs.readFileSync(catalogFile, 'utf8')).ids;

async function seed() {
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'pokemontcg' WHERE id = 1`);
  await db.run(`INSERT INTO users (id, username, password_hash, role, share_token)
    VALUES (1, 'owner', 'unused', 'admin', 'share-owner'), (2, 'alice', 'unused', 'member', 'share-alice')`);
  // The old provider's rows, through its own normalizer.
  await tcgApi.cacheCards(legacy);
  // The same Pineco added again after an earlier switch: the split this exists for.
  await tcgdexApi.cacheCards([tcgdexApi.normalizeCard({ ...briefs.get('sv01-001'), category: 'Pokemon', rarity: 'Common',
    pricing: { cardmarket: { avg: 0.04, trend: 0.04 } } }, 'en')]);

  const binder = (await db.run(`INSERT INTO locations (name, type, game, user_id, fixed_slots) VALUES ('151 binder', 'Binder', 'pokemon', 1, ?)`,
    [json([{ set_id: 'sv3pt5', start_slot: 1, max_number: 165 }, { set_id: 'swsh12pt5gg', start_slot: 170, max_number: 70 }])])).lastID;
  await db.createCompartments(binder, 2, 9);
  const box = (await db.run(`INSERT INTO locations (name, type, game, user_id, rule_type, rule_config) VALUES ('GO box', 'Box', 'any', 1, 'compound', ?)`,
    [json({ rules: [{ field: 'set_id', operator: 'equals', value: 'pgo', action: 'include' }] })])).lastID;
  await db.createCompartments(box, 1, 100);
  const [page] = await db.all(`SELECT id FROM compartments WHERE location_id = ? ORDER BY idx`, [binder]);
  await db.run(`UPDATE compartments SET rule_config = ? WHERE id = ?`, [json([{ field: 'set_id', operator: 'equals', value: 'sv1', action: 'include' }]), page.id]);

  const copy = (userId, cardId, o = {}) => db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, game, notes)
     VALUES (?, ?, 1, 'Near Mint', ?, 'English', ?, ?, ?, ?, 'pokemon', ?)`,
    [cardId, userId, o.printing || 'Normal', o.price ?? null, o.location ?? null, o.compartment ?? null, o.position ?? 0, o.notes || '']);
  let slot = 0;
  for (const card of legacy) await copy(1, card.id, { location: binder, compartment: page.id, position: (++slot) * 1000 });
  await copy(1, 'sv1-1', { printing: 'Reverse Holofoil', notes: 'second copy' });
  await copy(1, 'tcgdex-en-sv01-001', { notes: 'added after the switch' });
  for (const id of ['sv1-1', 'sv2-11', 'pgo-11']) await copy(2, id, { price: 0.5 });

  const deck = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (1, 'Mixed', 'pokemon')`)).lastID;
  // base1-58 is in a deck only and was never cached.
  for (const [id, q] of [['sv1-1', 2], ['tcgdex-en-sv01-001', 1], ['sv3pt5-25', 1], ['base1-58', 3], ['sv2-11', 1]]) {
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)`, [deck, id, q]);
  }
  const theirs = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (2, 'Alice', 'pokemon')`)).lastID;
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'pgo-11', 1)`, [theirs]);

  const point = (id, at, price, currency = 'USD') => db.run(`INSERT INTO price_history (card_id, price, currency, recorded_at) VALUES (?, ?, ?, ?)`, [id, price, currency, at]);
  await point('sv1-1', '2026-10-01 10:00:00', 0.05);
  await point('sv1-1', '2026-10-02 10:00:00', 0.06);
  await point('sv1-1', '2026-10-03 10:00:00.250', 0.07);
  await point('tcgdex-en-sv01-001', '2026-10-02 10:00:00', 0.04, 'EUR'); // the same instant as an sv1-1 point
  await point('tcgdex-en-sv01-001', '2026-10-05 08:00:00', 0.05, 'EUR');
  await point('base1-4', '2026-09-01 12:00:00', 340);
  await point('base1-4', '2026-10-01 12:00:00', 352.5);
  await point('pgo-11', '2026-10-01 12:00:00', 7.2);
  await point('mcd14-1', '2026-10-01 12:00:00', 1.25);

  for (const [id, pid] of [['base1-4', 42382], ['sv1-1', 5551], ['tcgdex-en-sv01-001', 5551], ['sv1-3', 3003], ['sma-SV2', 1002], ['fut20-5', 2111]]) {
    await db.run(`INSERT INTO tcgplayer_product (card_id, product_id, category_id, confidence) VALUES (?, ?, 3, 1)`, [id, pid]);
  }
  for (const [pid, group, setId, number] of [[42382, 'Base Set', 'base1', '4'], [9999, 'SV01: Scarlet & Violet Base Set', 'sv01', '3'],
    [1002, 'Hidden Fates: Shiny Vault', 'sma', 'SV02'], [2002, 'Hidden Fates', 'sm11.5', 'SV02'], [2111, 'Pokémon Futsal 2020', 'fut2020', '5']]) {
    await db.run(`INSERT INTO tcgplayer_catalog (product_id, category_id, group_id, group_name, set_id, name, number) VALUES (?, 3, ?, ?, ?, '', ?)`,
      [pid, pid, group, setId, number]);
  }

  // A table this code has never heard of, the way a sealed-products link would look.
  await db.run(`CREATE TABLE sealed_contents (id INTEGER PRIMARY KEY AUTOINCREMENT, sealed_id INTEGER NOT NULL, card_id TEXT NOT NULL)`);
  await db.run(`INSERT INTO sealed_contents (sealed_id, card_id) VALUES (1, 'swshp-SWSH050'), (1, 'mcd14-1')`);

  fs.mkdirSync(cardArt.USER_DIR, { recursive: true });
  fs.writeFileSync(path.join(cardArt.USER_DIR, 'sv3pt5-25.png'), Buffer.from('uploaded art for the old id'));

  fs.mkdirSync(process.env.CV_MODEL_DIR, { recursive: true });
  const ids = ['base1-4', 'sv1-1', 'sv3pt5-25', 'mcd14-1', 'tcgdex-en-sv01-001'];
  fs.writeFileSync(catalogFile, json({ dim: 2, ids, srcs: Object.fromEntries(ids.map(i => [i, `https://img.example/${i}.png`])), game: 'pokemon', lang: 'English' }));
  fs.writeFileSync(catalogFile.replace(/\.json$/, '.bin'), Buffer.alloc(ids.length * 2 * 4));
}

async function snapshot() {
  const q = (sql) => db.all(sql);
  return {
    collection: await q(`SELECT * FROM collection ORDER BY id`),
    deck_cards: await q(`SELECT * FROM deck_cards ORDER BY deck_id, card_id`),
    price_history: await q(`SELECT * FROM price_history ORDER BY card_id, recorded_at`),
    tcgplayer_product: await q(`SELECT * FROM tcgplayer_product ORDER BY card_id`),
    card_cache: await q(`SELECT * FROM card_cache ORDER BY id`),
    locations: await q(`SELECT id, fixed_slots, rule_config FROM locations ORDER BY id`),
    compartments: await q(`SELECT id, rule_config FROM compartments ORDER BY id`),
    sealed_contents: await q(`SELECT * FROM sealed_contents ORDER BY id`),
    provider: (await db.get(`SELECT pokemon_provider FROM app_settings WHERE id = 1`)).pokemon_provider,
    art: fs.readdirSync(cardArt.USER_DIR).sort(),
  };
}
const USER_DATA = ['collection', 'deck_cards', 'price_history', 'tcgplayer_product', 'locations', 'compartments', 'sealed_contents', 'provider', 'art'];
const userData = (s) => Object.fromEntries(USER_DATA.map(k => [k, s[k]]));

// Background follow-up first, then the product-map build a provider switch starts.
async function settle() {
  await migration.idle();
  for (let i = 0; i < 200 && tcgplayerCatalog.state(); i++) await new Promise(r => setTimeout(r, 25));
  assert.strictEqual(tcgplayerCatalog.state(), null, 'the product map build finished');
}

// --- HTTP ----------------------------------------------------------------------
let base;
async function session(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [require('../src/utils/authHelpers').hashSessionToken(token), userId, new Date(Date.now() + 864e5).toISOString()]);
  return token;
}
async function call(method, url, token, body) {
  const res = await fetch(`${base}/api/admin/pokemon-migration${url}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await session(1);
  const member = await session(2);

  // Admin only.
  for (const [method, url] of [['GET', '/status'], ['GET', '/preview'], ['POST', '/apply'], ['POST', '/revert']]) {
    assert.strictEqual((await call(method, url, member, method === 'POST' ? {} : undefined)).status, 403, `${method} ${url} is admin-only`);
  }

  const status = await call('GET', '/status', admin);
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.body.configured_provider, 'pokemontcg');
  assert.strictEqual(status.body.target_provider, 'tcgdex');
  assert.strictEqual(status.body.pending.ids, 18, 'every pokemontcg.io id in a collection or a Pokémon deck');
  assert.strictEqual(status.body.pending.users, 2);
  assert.strictEqual(status.body.sunset, '2027-03-01');

  // --- preview: a dry run ---------------------------------------------------------
  const before = await snapshot();
  const preview = await call('GET', '/preview', admin);
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  const report = preview.body;
  assert.deepStrictEqual(await snapshot(), before, 'the preview changes nothing');
  assert.deepStrictEqual(
    { total: report.counts.total, mapped: report.counts.mapped, product: report.counts.product, ambiguous: report.counts.ambiguous, unmapped: report.counts.unmapped, migratable: report.counts.migratable },
    { total: 18, mapped: 11, product: 1, ambiguous: 3, unmapped: 3, migratable: 12 });
  assert.strictEqual(report.counts.confirmed, 4, 'base1-4, sv1-1, sma-SV2 and the product-only fut20-5 agree on a TCGplayer product');
  assert.strictEqual(report.switches_provider, true);
  assert.strictEqual(report.rows.collection, 14, 'collection rows on ids that will move');
  assert.strictEqual(report.rows.deck_cards, 4);
  assert.strictEqual(report.rows.sealed_contents, 1, 'the unknown table was found from the schema');
  assert.strictEqual(report.rows.card_art, 1, 'the uploaded art that will follow its card');
  assert.deepStrictEqual(report.unresolved.map(u => u.old_id).sort(), LEFT);
  const sv2 = report.unresolved.find(u => u.old_id === 'sv2-11');
  assert.deepStrictEqual(sv2.owners.map(o => [o.username, o.collection_rows, o.deck_rows]).sort(), [['alice', 1, 0], ['owner', 1, 1]]);
  assert.deepStrictEqual(Object.keys(sv2.owners[0]).sort(), ['collection_rows', 'deck_rows', 'user_id', 'username'], 'no user data beyond who and how many');
  const sv1 = report.sets.find(s => s.source_set === 'sv1');
  assert.deepStrictEqual([sv1.target_set, sv1.mapped, sv1.ambiguous, sv1.unmapped], ['sv01', 1, 1, 1]);
  assert.deepStrictEqual(report.errors.map(e => e.set_id), ['sv04']);
  assert.strictEqual(report.storage.changes, 2, 'the 151 fixed slots and the GO rule');
  assert.deepStrictEqual(report.storage.blocked.map(b => [b.set_id, b.reason]).sort(), [['sv1', 'cards_left'], ['swsh12pt5gg', 'merged']]);
  assert.ok(report.examples.length > 0 && report.examples.every(e => MOVED[e.old_id] === e.new_id));

  // --- apply ------------------------------------------------------------------------
  assert.strictEqual((await call('POST', '/apply', admin, {})).status, 400, 'apply needs the preview it confirms');
  assert.strictEqual((await call('POST', '/apply', admin, { plan_id: '0123456789abcdef' })).status, 409, 'an unknown plan is refused');
  const applied = await call('POST', '/apply', admin, { plan_id: report.plan_id });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  const run = applied.body.run;
  await settle();

  assert.ok(run.backup_file && fs.existsSync(path.join(tmpDir, 'backups', run.backup_file)), 'a backup was taken first');
  assert.strictEqual(run.summary.ids, 12);
  const after = await snapshot();
  const cardIds = new Set(after.card_cache.map(r => r.id));

  // Every collection row survives, in place, pointing at the new id.
  assert.strictEqual(after.collection.length, before.collection.length, 'no collection row lost');
  for (const [i, row] of before.collection.entries()) {
    const now = after.collection[i];
    assert.strictEqual(now.id, row.id);
    assert.strictEqual(now.card_id, MOVED[row.card_id] || row.card_id, `collection row ${row.id}`);
    for (const col of ['user_id', 'position', 'compartment_id', 'printing', 'notes', 'purchase_price']) assert.strictEqual(now[col], row[col]);
  }
  for (const id of Object.keys(MOVED)) {
    assert.ok(!cardIds.has(id), `${id}'s old row is gone`);
    assert.ok(cardIds.has(MOVED[id]), `${MOVED[id]} exists`);
  }
  for (const id of LEFT) assert.ok(cardIds.has(id), `${id} is left exactly where it was`);

  // The deck that held Pineco under both ids now holds three of one.
  const deckRows = (deckId) => Object.fromEntries(after.deck_cards.filter(r => r.deck_id === deckId).map(r => [r.card_id, r.quantity]));
  assert.deepStrictEqual(deckRows(1), { 'tcgdex-en-sv01-001': 3, 'tcgdex-en-sv03.5-025': 1, 'tcgdex-en-base1-58': 3, 'sv2-11': 1 });
  assert.deepStrictEqual(deckRows(2), { 'tcgdex-en-swsh10.5-011': 1 });

  // History follows the card; the one point that collided keeps the target's.
  assert.strictEqual(after.price_history.length, before.price_history.length - 1);
  assert.deepStrictEqual(after.price_history.filter(p => p.card_id === 'tcgdex-en-sv01-001').map(p => [p.recorded_at, p.price]),
    [['2026-10-01 10:00:00', 0.05], ['2026-10-02 10:00:00', 0.04], ['2026-10-03 10:00:00.250', 0.07], ['2026-10-05 08:00:00', 0.05]]);
  assert.strictEqual(after.price_history.filter(p => p.card_id === 'tcgdex-en-base1-4').length, 2);
  assert.strictEqual(after.price_history.filter(p => p.card_id === 'mcd14-1').length, 1);

  assert.deepStrictEqual(after.tcgplayer_product.map(r => [r.card_id, r.product_id]),
    [['sv1-3', 3003], ['tcgdex-en-base1-4', 42382], ['tcgdex-en-fut2020-5', 2111], ['tcgdex-en-sma-SV02', 1002], ['tcgdex-en-sv01-001', 5551]]);
  assert.deepStrictEqual(after.sealed_contents.map(r => r.card_id), ['tcgdex-en-swshp-SWSH050', 'mcd14-1']);
  assert.strictEqual(after.provider, 'tcgdex', 'the install now asks TCGdex');

  // Storage settings that name a set move with it, unless that would change what they hold.
  assert.deepStrictEqual(JSON.parse(after.locations[0].fixed_slots).map(e => e.set_id), ['sv03.5', 'swsh12pt5gg']);
  assert.strictEqual(JSON.parse(after.locations[1].rule_config).rules[0].value, 'swsh10.5');
  assert.strictEqual(JSON.parse(after.compartments[0].rule_config)[0].value, 'sv1', 'sv1 still has cards left on old ids');

  // Art and the scan catalog follow.
  assert.deepStrictEqual(after.art, ['sv3pt5-25.png', 'tcgdex-en-sv03.5-025.png']);
  assert.ok(cardArt.listIds().includes('tcgdex-en-sv03.5-025'), 'the art index was refreshed');
  assert.deepStrictEqual(catalogIds(), ['tcgdex-en-base1-4', 'tcgdex-en-sv01-001', 'tcgdex-en-sv03.5-025', 'mcd14-1', 'tcgdex-en-sv01-001']);

  // Refreshed through the provider; the one whose details failed kept the old
  // row's data, stamped stale, and is counted.
  const row = (id) => after.card_cache.find(r => r.id === id);
  assert.strictEqual(row('tcgdex-en-sv03.5-025').supertype, 'Pokémon');
  assert.strictEqual(row('tcgdex-en-sv03.5-025').price_trend, 0.31);
  assert.ok(row('tcgdex-en-sv03.5-025').last_updated > '2000');
  const tg = row('tcgdex-en-swsh9tg-TG01');
  assert.deepStrictEqual([tg.rarity, tg.price_trend, tg.price_source, tg.last_updated], ['Trainer Gallery Rare Holo', 1.8, 'pokemontcg', '1970-01-01 00:00:00']);
  assert.strictEqual(tg.image_url, 'https://assets.tcgdex.net/en/swsh/swsh9tg/TG01/low.png', 'name, number and art are the target provider\'s');
  const state = (await call('GET', '/status', admin)).body;
  assert.strictEqual(state.follow_up.phase, 'done');
  assert.strictEqual(state.follow_up.failed, 1);
  assert.strictEqual(state.pending.ids, 6, 'only the ids that could not be matched remain');
  assert.strictEqual(state.runs[0].id, run.id);
  const log = await db.all(`SELECT old_id, new_id, method FROM pokemon_id_migration_log WHERE run_id = ? ORDER BY old_id`, [run.id]);
  assert.deepStrictEqual(Object.fromEntries(log.map(l => [l.old_id, l.new_id])), MOVED);
  assert.strictEqual(log.find(l => l.old_id === 'fut20-5').method, 'product-id');

  // --- re-run: a no-op that finishes what was left --------------------------------
  assert.strictEqual((await call('POST', '/apply', admin, { plan_id: report.plan_id })).body.already_applied, true, 'the same plan twice is one migration');
  failing.clear();
  const again = await call('GET', '/preview', admin);
  assert.strictEqual(again.body.counts.migratable, 0);
  assert.strictEqual(again.body.counts.total, 6);
  const rerun = await call('POST', '/apply', admin, { plan_id: again.body.plan_id });
  assert.strictEqual(rerun.status, 200);
  assert.strictEqual(rerun.body.noop, true);
  await settle();
  const after2 = await snapshot();
  assert.deepStrictEqual(userData(after2), userData(after), 're-running changes no user data');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM pokemon_id_migration_runs`)).n, 1, 'and records no second run');
  assert.ok(after2.card_cache.find(r => r.id === 'tcgdex-en-swsh9tg-TG01').last_updated > '2000', 'but retries the card details that failed');

  // --- revert -------------------------------------------------------------------------
  const undone = await call('POST', '/revert', admin, {});
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  await settle();
  const restored = await snapshot();
  for (const key of USER_DATA) assert.deepStrictEqual(restored[key], before[key], `${key} is back to how it was`);
  assert.deepStrictEqual(restored.card_cache, before.card_cache, 'card_cache is back to how it was, row for row');
  assert.deepStrictEqual(catalogIds(), ['base1-4', 'tcgdex-en-sv01-001', 'sv3pt5-25', 'mcd14-1', 'tcgdex-en-sv01-001'],
    'catalog ids the run created go back; the Pineco vector stays on the id that existed before');
  assert.ok(undone.body.reverted.reverted_at);
  assert.strictEqual((await call('POST', '/revert', admin, {})).status, 404, 'nothing left to undo');
  assert.strictEqual((await call('GET', '/status', admin)).body.pending.ids, 18);

  server.close();
  console.log(`pokemonmigration.test.js: all assertions passed (${tcgdexCalls.length} TCGdex requests, all from fixtures)`);
}

main()
  .then(() => 0, (error) => { console.error(error); return 1; })
  .then((code) => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may still hold the file */ }
      process.exit(code);
    }, 100);
  });
