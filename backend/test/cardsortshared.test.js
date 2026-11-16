// Card ordering is one module now (shared/cardSort.mjs), used by the filing engine
// (utils/compartmentSort.js) and by every view that draws cards in order
// (frontend/src/utils/cardSort.js). The two copies it replaced had drifted:
//
//   - neither ranked Lorcana's or Riftbound's top rarities, so a descending
//     rarity sort read Super Rare, Common, Enchanted, Legendary;
//   - the backend had no case for added_at or entry_id, so a "newest first"
//     container filed a new card last.
//
// The last part runs the frontend's sorter and the backend's side by side over
// random cards, so the two cannot drift apart again unnoticed.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { pathToFileURL } = require('url');

const tmpDb = path.join(os.tmpdir(), `bindarr-cardsortshared-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const db = require('../src/db');
const { sortCards, recommendSlot, loadSetsCache } = require('../src/utils/compartmentSort');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const names = (cards) => cards.map(c => c.name);

function rarities() {
  const lorcana = ['Common', 'Legendary', 'Super Rare', 'Enchanted', 'Uncommon', 'Rare', 'Iconic', 'Epic'].map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(lorcana, [{ by: 'rarity', dir: 'desc' }])),
    ['Iconic', 'Enchanted', 'Epic', 'Legendary', 'Super Rare', 'Rare', 'Uncommon', 'Common'],
    "Lorcana's rarities sort rarest first, Super Rare above Rare");
  const riftbound = ['Rare', 'Showcase', 'Common', 'Epic', 'Uncommon'].map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(riftbound, [{ by: 'rarity', dir: 'desc' }])),
    ['Showcase', 'Epic', 'Rare', 'Uncommon', 'Common'], "Riftbound's rarities sort rarest first");

  // Pokémon's and Magic's tiers keep the order they always had.
  const classic = ['classic collection', 'hyper rare', 'special illustration rare', 'illustration rare', 'secret rare',
    'ultra rare', 'radiant rare', 'amazing rare', 'shiny rare', 'double rare', 'mythic', 'rare holo', 'promo', 'rare',
    'uncommon', 'common', 'special'];
  const shuffled = [...classic].reverse().map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(shuffled, [{ by: 'rarity', dir: 'desc' }])), classic,
    'the Pokémon and Magic tiers are ranked exactly as before');
  // The games served from TCGplayer's catalogue, in TCGplayer's own rarity names.
  const yugioh = ['Common', 'Starlight Rare', 'Ultimate Rare', 'Short Print', 'Ghost Rare', 'Secret Rare',
    "Collector's Rare", 'Super Rare', 'Ultra Rare', 'Rare', 'Quarter Century Secret Rare'].map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(yugioh, [{ by: 'rarity', dir: 'desc' }])),
    ['Starlight Rare', 'Ghost Rare', 'Secret Rare', 'Quarter Century Secret Rare', 'Ultimate Rare', "Collector's Rare",
      'Ultra Rare', 'Super Rare', 'Rare', 'Short Print', 'Common'], "Yu-Gi-Oh!'s rarities sort rarest first");
  const fab = ['Common', 'Fabled', 'Rare', 'Majestic', 'Marvel', 'Legendary', 'Super Rare'].map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(fab, [{ by: 'rarity', dir: 'desc' }])),
    ['Fabled', 'Marvel', 'Legendary', 'Majestic', 'Super Rare', 'Rare', 'Common'], "Flesh and Blood's rarities sort rarest first");
  const onepiece = ['Common', 'Leader', 'Treasure Rare', 'Secret Rare', 'Special Card', 'Super Rare', 'Rare', 'Uncommon']
    .map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(onepiece, [{ by: 'rarity', dir: 'desc' }])),
    ['Treasure Rare', 'Secret Rare', 'Special Card', 'Super Rare', 'Leader', 'Rare', 'Uncommon', 'Common'],
    "One Piece's rarities sort rarest first");
  // "Legend Rare" is not "Legendary": it used to read as plain Rare.
  const gundam = ['Common', 'Legend Rare', 'Rare', 'Uncommon', 'Promo'].map(r => ({ name: r, rarity: r }));
  assert.deepStrictEqual(names(sortCards(gundam, [{ by: 'rarity', dir: 'desc' }])),
    ['Legend Rare', 'Promo', 'Rare', 'Uncommon', 'Common'], "Gundam's rarities sort rarest first");
  console.log('PASS: rarity ranks cover Lorcana, Riftbound and the TCGplayer-catalogue games, the rest unchanged');
}

function newestFirst() {
  const cards = [
    { name: 'Old', added_at: '2026-01-01 10:00:00', entry_id: 3 },
    { name: 'New', added_at: '2026-03-01 10:00:00', entry_id: 1 },
    { name: 'Same time, later id', added_at: '2026-02-01 10:00:00', entry_id: 9 },
    { name: 'Same time, earlier id', added_at: '2026-02-01 10:00:00', entry_id: 5 },
  ];
  assert.deepStrictEqual(names(sortCards(cards, 'scanned-desc')),
    ['New', 'Same time, later id', 'Same time, earlier id', 'Old'], 'scanned-desc is newest first, then highest id');
  assert.deepStrictEqual(names(sortCards(cards, 'scanned-asc')),
    ['Old', 'Same time, earlier id', 'Same time, later id', 'New'], 'scanned-asc is oldest first');
  console.log('PASS: added_at and entry_id sort on the backend');
}

async function newestFirstFiling() {
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('sorter', 'x', 'admin', 'tok')`)).lastID;
  const loc = (await db.run(
    `INSERT INTO locations (name, type, sort_order, user_id) VALUES ('Newest Box', 'Box', 'scanned-desc', ?)`, [userId]
  )).lastID;
  const row = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 50)`, [loc])).lastID;
  for (const [id, added] of [['a', '2026-01-01 00:00:00'], ['b', '2026-02-01 00:00:00']]) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'pokemon')`, [id, id]);
    await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, added_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, loc, row, id === 'b' ? 1000 : 2000, added]);
  }
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('c', 'c', 'pokemon')`);
  const location = await db.get(`SELECT * FROM locations WHERE id = ?`, [loc]);
  const rec = await recommendSlot(db, location, { card_id: 'c', name: 'c', game: 'pokemon', printing: 'Normal', language: 'English' });
  assert.strictEqual(rec.position, 1000, `a card being added now is the newest: it files first, got ${rec.position}`);
  console.log('PASS: a newest-first container files a new card at the front');
}

async function frontendParity() {
  // The frontend imports the shared tables as plain .json modules (Vite bundles
  // them); bare Node needs them served as JavaScript, as the frontend tests do.
  const { register } = require('module');
  const jsonAsModule = `
import { readFile } from 'node:fs/promises';
export async function load(url, context, next) {
  if (!url.endsWith('.json')) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', source: 'export default ' + source, shortCircuit: true };
}`;
  register('data:text/javascript,' + encodeURIComponent(jsonAsModule), pathToFileURL(__filename));
  const frontend = await import(pathToFileURL(path.join(__dirname, '../../frontend/src/utils/cardSort.js')).href);

  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const sets = [{ name: 'Base' }, { name: 'Jungle' }, { name: 'Fossil' }, { name: 'Alpha' }];
  await db.run(`DELETE FROM sets`);
  for (const [i, s] of sets.entries()) await db.run(`INSERT INTO sets (id, name, release_date) VALUES (?, ?, ?)`, [`s${i}`, s.name, `199${i}-01-01`]);
  await loadSetsCache(db);
  const schemes = ['name-asc', 'price-desc', 'set-number', 'set-number-printing', 'type-name', 'language', 'scanned-desc', 'scanned-asc',
    [{ by: 'rarity', dir: 'desc' }, { by: 'number', dir: 'asc' }], [{ by: 'color', dir: 'asc' }, { by: 'cmc', dir: 'desc' }],
    [{ by: 'favorite', dir: 'desc' }, { by: 'set', dir: 'asc' }, { by: 'printing', dir: 'asc' }, { by: 'entry_id', dir: 'desc' }]];
  for (let run = 0; run < 200; run++) {
    const cards = Array.from({ length: 25 }, (_, i) => {
      const mtg = rnd() < 0.4;
      return {
        entry_id: i + 1,
        name: pick(['Pikachu', 'Bulbasaur', 'Sol Ring', 'Forest', 'Mewtwo', 'Eevee', 'Lightning Bolt']),
        game: mtg ? 'mtg' : pick(['pokemon', 'lorcana', 'riftbound']),
        supertype: mtg ? 'MTG' : 'Pokémon',
        types: mtg ? [pick(['Red', 'Blue'])] : [pick(['Fire', 'Water', 'Grass', 'Amber'])],
        subtypes: mtg ? [pick(['Creature', 'Instant', 'Land', 'Artifact'])] : ['Basic'],
        color_identity: mtg ? JSON.stringify(rnd() < 0.3 ? ['R', 'W'] : [pick(['R', 'U', 'G'])]) : [],
        rarity: pick(['Common', 'Rare', 'Legendary', 'Enchanted', 'mythic', 'Ultra Rare', 'Super Rare', 'Showcase']),
        set_name: pick([...sets.map(s => s.name), 'Unknown Set']),
        number: pick(['1', '2', '10', '10a', 'TG01', '']),
        printing: pick(['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition']),
        language: pick(['English', 'Japanese', 'German']),
        price_trend: Math.round(rnd() * 1000) / 10,
        cmc: Math.floor(rnd() * 6),
        favorite: rnd() < 0.3 ? 1 : 0,
        added_at: `2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)} 12:00:00`,
      };
    });
    const scheme = schemes[run % schemes.length];
    const foil = rnd() < 0.5 ? 'foils_first' : 'normals_first';
    const backend = sortCards(cards, scheme, foil).map(c => c.entry_id);
    const front = frontend.sortCardsByOrder([...cards], scheme, foil, sets).map(c => c.entry_id);
    assert.deepStrictEqual(front, backend, `scheme ${JSON.stringify(scheme)}: the frontend shows cards in the order the backend files them`);
  }
  console.log('PASS: frontend and backend sort 200 random hands identically');
}

async function main() {
  rarities();
  newestFirst();
  await db.initDb();
  await newestFirstFiling();
  await frontendParity();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
