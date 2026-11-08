// The id migration on an install already on pokemontcgapi.com: the target follows
// the configured provider (pokemonProvider.migrationTarget) rather than defaulting
// to TCGdex, the setting is left alone, and the moved cards are priced in one
// batched listing — never a two-credit detail fetch per card. Offline: the API is
// answered from inline fixtures in its documented shape.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-pokemonmigrationapi-${process.pid}-`));
process.env.DB_PATH = path.join(tmpDir, 'bindarr.db');
process.env.CV_MODEL_DIR = path.join(tmpDir, 'models');
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.POKEMONTCGAPI_KEY = 'offline-fixture-credential';

const axios = require('axios');
axios.defaults.adapter = async (config) => { throw new Error(`Unexpected network request: ${config.url}`); };
const db = require('../src/db');
const tcgApi = require('../src/tcgApi');
const api = require('../src/pokemontcgapi');
const migration = require('../src/pokemonMigration');

const listed = (id, number, name, extra = {}) => ({
  id, set_code: 'sv1', set_name: 'Scarlet & Violet', number, name, print_region: 'WEST', supertype: 'Pokémon',
  images: [{ face: 'FRONT', size: 'NORMAL', url: `https://images.example/${id}.png` }], tcgplayer_id: 5550 + Number(number), ...extra,
});
const calls = [];
api.client.defaults.adapter = async (config) => {
  calls.push({ url: config.url, params: { ...config.params } });
  const body = (data) => ({ status: 200, statusText: 'OK', headers: { etag: '"v1"' }, config, data: { data, meta: { has_more: false }, links: {} } });
  if (config.url === '/sets') {
    return body([{ code: 'sv1', name: 'Scarlet & Violet', series: 'Scarlet & Violet', total: 258, printed_total: 198, release_date: '2023-03-31' }]);
  }
  if (config.url === '/cards' && config.params.set === 'sv1') {
    return body([listed('sv1-1', '1', 'Pineco'), listed('sv1-3', '3', 'Pinsir')]);
  }
  if (config.url === '/cards' && config.params.q) {
    return body([listed('sv1-1', '1', 'Pineco', { prices: [{ source: 'TCGPLAYER', currency: 'USD', amount: 0.07, variant: 'MARKET', locale: 'en' }] })]);
  }
  throw new Error(`Unexpected pokemontcgapi.com request: ${config.url} ${JSON.stringify(config.params)}`);
};

(async () => {
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'pokemontcgapi' WHERE id = 1`);
  await db.run(`INSERT INTO users (id, username, password_hash, role, share_token) VALUES (1, 'owner', 'unused', 'admin', 'share-owner')`);
  await tcgApi.cacheCards([{ id: 'sv1-1', name: 'Pineco', supertype: 'Pokémon', subtypes: ['Basic'], types: ['Grass'], rarity: 'Common',
    set: { id: 'sv1', name: 'Scarlet & Violet' }, number: '1', images: { small: 'https://images.pokemontcg.io/sv1/1.png' },
    tcgplayer: { url: 'https://prices.pokemontcg.io/tcgplayer/sv1-1', prices: { normal: { market: 0.06 } } } }]);
  await db.run(`INSERT INTO tcgplayer_product (card_id, product_id, category_id) VALUES ('sv1-1', 5551, 3)`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game) VALUES ('sv1-1', 1, 1, 'pokemon'), ('sv1-1', 1, 1, 'pokemon')`);

  const report = await migration.preview();
  assert.strictEqual(report.target_provider, 'pokemontcgapi');
  assert.strictEqual(report.switches_provider, false);
  assert.strictEqual(report.counts.mapped, 1);
  assert.strictEqual(report.counts.confirmed, 1, 'the listing carries the TCGplayer product the old row was priced as');
  assert.deepStrictEqual(report.examples.map(e => e.new_id), ['pokemontcgapi-sv1-1']);
  assert.ok(calls.every(c => c.params.include === undefined || c.params.include === api.LIST_INCLUDE), 'the preview lists without prices');

  const { run } = await migration.apply(report.plan_id, { background: false });
  assert.strictEqual(run.summary.ids, 1);
  assert.strictEqual(run.summary.switched_provider, false);
  assert.deepStrictEqual((await db.all(`SELECT DISTINCT card_id FROM collection`)).map(r => r.card_id), ['pokemontcgapi-sv1-1']);
  assert.strictEqual((await db.get(`SELECT pokemon_provider FROM app_settings`)).pokemon_provider, 'pokemontcgapi');
  const card = await db.get(`SELECT price_trend, price_source FROM card_cache WHERE id = 'pokemontcgapi-sv1-1'`);
  assert.deepStrictEqual(card, { price_trend: 0.07, price_source: 'pokemontcgapi-tcgplayer' });
  const priced = calls.filter(c => c.params.q);
  assert.strictEqual(priced.length, 1, 'one batched, priced listing');
  assert.strictEqual(priced[0].params.include, api.CARD_INCLUDE);
  assert.ok(!calls.some(c => /^\/cards\/./.test(c.url)), 'no per-card detail fetch');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM card_cache WHERE id = 'sv1-1'`)).n, 0);

  await migration.revert();
  await migration.idle();
  assert.deepStrictEqual((await db.all(`SELECT DISTINCT card_id FROM collection`)).map(r => r.card_id), ['sv1-1']);
  console.log('pokemonmigrationapi.test.js: all assertions passed');
})()
  .then(() => 0, (error) => { console.error(error); return 1; })
  .then((code) => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may still hold the file */ }
      process.exit(code);
    }, 100);
  });
