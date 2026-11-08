// The one-off move of pokemontcg.io card ids onto the provider that replaces it.
//
// pokemontcg.io stops serving on 1 March 2027. An install that predates the
// provider setting is pinned to it (db.js), and even one that switched in Admin
// keeps every card collected before the switch under pokemontcg.io ids: the
// switch re-syncs the set list, it does not touch an owned row. So a set collected
// across the switch shows up twice — `sv1-*` from before, `tcgdex-en-sv01-*` from
// after — in completion, sorting and dividers, and after the shutdown the `sv1-*`
// half can never be refreshed or priced again.
//
// Three steps, each its own admin endpoint (routes/pokemonMigration.js):
//
//   preview  map every pokemontcg.io id the install references onto the target
//            provider (utils/pokemonIdMap decides; this fetches what it needs),
//            report it, and keep the plan for apply. Changes no user data.
//   apply    back the database up, then re-key every table that stores a card id
//            inside ONE transaction, journaling what an exact undo needs; then
//            refresh the new rows from the provider in the background.
//   revert   the journal played backwards, for the newest run.
//
// Only `mapped` and `product` entries move. Ambiguous and unmapped ids stay as
// they are and are listed, because a wrong re-key files a user's card as a
// different card and nothing downstream could tell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const backup = require('./backup');
const cardArt = require('./cardArt');
const cardApi = require('./utils/cardApi');
const pokemonProvider = require('./utils/pokemonProvider');
const idMap = require('./utils/pokemonIdMap');
const { cacheNormalizedCards } = require('./utils/cardCache');

// A preview is what the admin confirmed; an hour later the data under it has
// moved on enough that apply should ask for a fresh one.
const PLAN_TTL_MS = 60 * 60 * 1000;
// Set listings are reused across previews, so "check again" after a fix costs a
// database pass rather than another walk of the provider's sets.
const LISTING_TTL_MS = 60 * 60 * 1000;
// Both providers are someone else's API: a handful of requests at a time, the
// same fan-out tcgdexApi and catalog builds hold themselves to.
const LIST_CONCURRENCY = 4;
const HYDRATE_CONCURRENCY = 4;
const CHUNK = 500;
const MAP = 'temp.pokemon_id_map';
const PROVIDER_LABEL = { tcgdex: 'TCGdex', pokemontcgapi: 'pokemontcgapi.com', pokemontcg: 'pokemontcg.io' };

// Tables whose collisions need their own rule. Every other column found holding a
// card id is re-keyed generically, by rowid, and a constraint it trips rolls the
// whole migration back rather than being guessed around.
const SPECIAL = new Set(['collection.card_id', 'deck_cards.card_id', 'price_history.card_id', 'tcgplayer_product.card_id']);
// Rebuilt by the price sweep, so re-keyed alongside an id that moves but never a
// reason on its own to move one: a card sold years ago still has its product row.
const DERIVED = new Set(['tcgplayer_product.card_id']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const marks = (n) => new Array(n).fill('?').join(', ');
const chunks = (list, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const unique = (list) => [...new Set(list)];
const parseList = (v) => {
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// `{in}` in the SQL is replaced by one chunk's placeholders at a time.
async function selectIn(sql, values) {
  const out = [];
  for (const part of chunks(values)) out.push(...await db.all(sql.replace('{in}', marks(part.length)), part));
  return out;
}

async function mapLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

let planCache = null;   // the last preview, kept for apply
let previewing = null;  // an in-flight preview, shared by concurrent callers
let busy = null;        // 'apply' | 'revert' while one is running
let followUp = null;    // the background refresh after the last apply
const listingCache = new Map();

// --- what references a pokemontcg.io id ---------------------------------------

// Every column that stores a card id, found from the schema rather than listed
// here: anything named card_id, plus any column with a foreign key to card_cache.
// A table added later (sealed links, say) is then re-keyed too instead of being
// left pointing at ids that no longer exist.
async function cardIdColumns() {
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const out = [];
  for (const { name } of tables) {
    if (name === 'card_cache' || name.startsWith('pokemon_id_migration_')) continue;
    const cols = await db.all(`PRAGMA table_info(${ident(name)})`);
    const fks = new Set((await db.all(`PRAGMA foreign_key_list(${ident(name)})`)).filter(f => f.table === 'card_cache').map(f => f.from));
    for (const c of cols) {
      if (c.name === 'card_id' || fks.has(c.name)) out.push({ table: name, column: c.name, key: `${name}.${c.name}` });
    }
  }
  return out;
}

function userArtIds() {
  try {
    return fs.readdirSync(cardArt.USER_DIR).filter(n => n.toLowerCase().endsWith('.png')).map(n => n.slice(0, -4));
  } catch {
    return [];
  }
}

// id -> { table: rows } for every pokemontcg.io-shaped id the user's data holds.
//
// Uploaded art is not on the list. It follows an id that moves (copyArt), but it
// is no reason to move one: the copy leaves the old file in place, so counting it
// would offer the same card for migration again after every run.
async function legacyReferences(columns) {
  const refs = new Map();
  const add = (id, key, n) => {
    if (!refs.has(id)) refs.set(id, {});
    refs.get(id)[key] = (refs.get(id)[key] || 0) + n;
  };
  for (const col of columns) {
    if (DERIVED.has(col.key)) continue;
    const c = ident(col.column);
    const rows = await db.all(
      `SELECT ${c} AS id, COUNT(*) AS n FROM ${ident(col.table)}
        WHERE ${c} IS NOT NULL AND ${['mtg-', 'tcgdex-', 'pokemontcgapi-', 'lorcana-'].map(p => `${c} NOT LIKE '${p}%'`).join(' AND ')}
        GROUP BY ${c}`
    );
    for (const r of rows) if (idMap.isLegacyId(r.id)) add(r.id, col.table, r.n);
  }
  return refs;
}

// What the old side knows about each id: its card_cache row, else what the id
// itself says (a deck can name a card this install never cached).
async function sourceFacts(refs) {
  const ids = [...refs.keys()].sort();
  const rows = new Map((await selectIn(
    `SELECT id, name, set_id, set_name, number, game, tcgplayer_product_id FROM card_cache WHERE id IN ({in})`, ids
  )).map(r => [r.id, r]));
  const products = new Map((await selectIn(
    `SELECT card_id, product_id FROM tcgplayer_product WHERE card_id IN ({in})`, ids
  )).map(r => [r.card_id, r.product_id]));
  const setNames = new Map((await db.all(`SELECT id, name FROM sets WHERE game = 'pokemon'`)).map(s => [String(s.id).toLowerCase(), s.name]));
  // An uncached id has no game of its own; one listed in another game's deck is that game's.
  const otherGame = new Set((await selectIn(`SELECT DISTINCT dc.card_id AS id FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
    WHERE COALESCE(d.game, 'pokemon') <> 'pokemon' AND dc.card_id IN ({in})`, ids.filter(id => !rows.has(id)))).map(r => r.id));
  const sources = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row ? row.game !== 'pokemon' : otherGame.has(id)) continue;
    const parsed = idMap.parseLegacyId(id);
    const setId = (row && row.set_id) || parsed.set_id;
    sources.push({
      id,
      set_id: setId,
      set_name: (row && row.set_name) || setNames.get(String(setId).toLowerCase()) || '',
      number: (row && row.number) || parsed.number,
      name: (row && row.name) || '',
      product_id: Number((row && row.tcgplayer_product_id) || products.get(id) || 0) || null,
    });
  }
  return sources;
}

// --- the target side -----------------------------------------------------------

async function target() {
  const configured = await pokemonProvider.configured();
  const provider = pokemonProvider.migrationTarget(configured);
  return { configured, provider, client: pokemonProvider.clientFor(provider) };
}

async function listSet(provider, client, setId) {
  const key = `${provider}:${setId}`;
  const hit = listingCache.get(key);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.cards;
  const cards = await client.getSetCards(setId, 'en');
  listingCache.set(key, { at: Date.now(), cards });
  return cards;
}

// The TCGCSV product map, English category only, keyed by set and number. Its set
// ids are in whatever numbering the `sets` table had when it was built, which is
// why it is read for both sides' sets.
async function productMapBySetNumber(setIds) {
  const english = require('./tcgcsvApi').CATEGORY.english;
  const map = new Map();
  const rows = await selectIn(
    `SELECT product_id, set_id, number FROM tcgplayer_catalog WHERE category_id = ${Number(english)} AND LOWER(set_id) IN ({in})`,
    unique(setIds.filter(Boolean).map(s => String(s).toLowerCase()))
  );
  for (const r of rows) {
    const key = idMap.setNumberKey(r.set_id, r.number);
    map.set(key, map.has(key) && map.get(key) !== r.product_id ? null : r.product_id);
  }
  return map;
}

async function productMapByProduct(productIds) {
  const { stripGroupCode } = require('./tcgcsvApi');
  const rows = await selectIn(`SELECT product_id, set_id, group_name, number FROM tcgplayer_catalog WHERE product_id IN ({in})`, productIds);
  return new Map(rows.map(r => [Number(r.product_id), { set_id: r.set_id || '', set_name: stripGroupCode(r.group_name || ''), number: r.number }]));
}

const ownsId = (provider, id) => (provider === pokemonProvider.POKEMONTCGAPI ? cardApi.isPokemontcgapiId(id) : cardApi.isTcgdexId(id));

// Product ids the target side already carries: on card_cache rows, or in the
// product mapping the price sweep keeps.
async function targetProducts(ids) {
  const map = new Map();
  for (const r of await selectIn(`SELECT id, tcgplayer_product_id AS pid FROM card_cache WHERE tcgplayer_product_id IS NOT NULL AND id IN ({in})`, ids)) {
    map.set(r.id, Number(r.pid));
  }
  for (const r of await selectIn(`SELECT card_id AS id, product_id AS pid FROM tcgplayer_product WHERE card_id IN ({in})`, ids)) {
    if (!map.has(r.id)) map.set(r.id, Number(r.pid));
  }
  return map;
}

// Target rows already cached under one of these products, for the product-only
// path when the card sits in a set nothing else made us list.
async function targetsByProduct(provider, productIds) {
  const known = new Map();
  const rows = [
    ...await selectIn(`SELECT id, set_id, set_name, number, name, tcgplayer_product_id AS product_id FROM card_cache
      WHERE game = 'pokemon' AND language = 'English' AND tcgplayer_product_id IN ({in})`, productIds),
    ...await selectIn(`SELECT cc.id, cc.set_id, cc.set_name, cc.number, cc.name, tp.product_id FROM tcgplayer_product tp
      JOIN card_cache cc ON cc.id = tp.card_id WHERE cc.game = 'pokemon' AND cc.language = 'English' AND tp.product_id IN ({in})`, productIds),
  ];
  for (const r of rows) if (ownsId(provider, r.id) && !known.has(r.id)) known.set(r.id, { ...r, product_id: Number(r.product_id) });
  return known;
}

// --- storage settings that name a set ------------------------------------------

async function storageRows() {
  const locations = await db.all(`SELECT id, game, fixed_slots, rule_config FROM locations`);
  const compartments = await db.all(
    `SELECT c.id, c.rule_config, l.game FROM compartments c JOIN locations l ON l.id = c.location_id WHERE c.rule_config IS NOT NULL`
  );
  return { locations, compartments };
}

// Locations for Pokémon may follow a set-level match for a set nobody owns a card
// of; mixed-game ('any') ones only follow moves the cards themselves proved, since
// a bare set code there may as well be Magic's.
async function storageMoves(entries, targetSets) {
  const { locations, compartments } = await storageRows();
  const pokemonOnly = [...locations.filter(l => l.game === 'pokemon'), ...compartments.filter(c => c.game === 'pokemon')];
  const named = unique(pokemonOnly.flatMap(r => idMap.storageSetIds(r.fixed_slots, [r.rule_config])));
  const setNames = new Map((await db.all(`SELECT id, name FROM sets WHERE game = 'pokemon'`)).map(s => [String(s.id).toLowerCase(), s.name]));
  const storageSets = named.map(id => ({ id, name: setNames.get(id.toLowerCase()) || '' }));
  const all = idMap.setMoves(entries, { targetSets, storageSets });
  const proved = idMap.setMoves(entries, { targetSets });
  return { moves: all.moves, cardMoves: proved.moves, blocked: all.blocked, locations, compartments };
}

const movesFor = (game, storage) => (game === 'pokemon' ? storage.moves : (!game || game === 'any') ? storage.cardMoves : null);

// What a rewrite would change, without writing it: [{ table, id, column, before, after }].
function storageChanges(storage) {
  const out = [];
  for (const loc of storage.locations) {
    const moves = movesFor(loc.game, storage);
    if (!moves || !moves.size) continue;
    const fixed = idMap.remapFixedSlots(loc.fixed_slots, moves);
    if (fixed) out.push({ table: 'locations', id: loc.id, column: 'fixed_slots', before: loc.fixed_slots, after: fixed });
    const rules = idMap.remapRules(loc.rule_config, moves);
    if (rules) out.push({ table: 'locations', id: loc.id, column: 'rule_config', before: loc.rule_config, after: rules });
  }
  for (const comp of storage.compartments) {
    const moves = movesFor(comp.game, storage);
    if (!moves || !moves.size) continue;
    const rules = idMap.remapRules(comp.rule_config, moves);
    if (rules) out.push({ table: 'compartments', id: comp.id, column: 'rule_config', before: comp.rule_config, after: rules });
  }
  return out;
}

// --- preview -------------------------------------------------------------------

async function computePlan() {
  const { configured, provider, client } = await target();
  const columns = await cardIdColumns();
  const refs = await legacyReferences(columns);
  // Reported alongside the tables, so the admin sees the art that will follow.
  for (const id of userArtIds()) if (refs.has(id)) refs.get(id).card_art = 1;
  const sources = await sourceFacts(refs);
  const plan = {
    id: crypto.randomBytes(8).toString('hex'), at: Date.now(), configured, target: provider,
    entries: [], targetSets: [], targetRows: new Map(), errors: [], refs, storage: null,
  };
  if (sources.length) {
    let targetSets;
    try {
      targetSets = (await client.listSets('en')).map(s => ({ id: s.id, name: s.name }));
    } catch (e) {
      throw fail(502, `Could not read the ${PROVIDER_LABEL[provider]} set list (${e.message}). Nothing was changed; try again later.`);
    }
    if (!targetSets.length) throw fail(502, `${PROVIDER_LABEL[provider]} returned no sets. Nothing was changed; try again later.`);
    plan.targetSets = targetSets;

    const bySetNumber = await productMapBySetNumber(sources.map(s => s.set_id));
    const sourcePids = unique(sources.map(s => idMap.sourceProductOf(s, bySetNumber)).filter(Boolean));
    const catalog = await productMapByProduct(sourcePids);
    const needed = idMap.setsToList({ sources, targetSets, products: { catalog, bySetNumber } });

    const listings = new Map();
    const failedSets = new Set();
    await mapLimited(needed, LIST_CONCURRENCY, async (setId) => {
      try {
        const rows = await listSet(provider, client, setId);
        for (const row of rows) plan.targetRows.set(row.id, row);
        listings.set(setId, rows.map(row => ({ ...row, product_id: Number(row.tcgplayer_product_id || 0) || null })));
      } catch (e) {
        failedSets.add(setId);
        plan.errors.push({ set_id: setId, message: e.message });
      }
    });
    for (const [key, pid] of await productMapBySetNumber(needed)) if (!bySetNumber.has(key)) bySetNumber.set(key, pid);
    const ofTarget = await targetProducts([...plan.targetRows.keys()]);
    const known = await targetsByProduct(provider, sourcePids);
    for (const [id, card] of known) if (!ofTarget.has(id) && card.product_id) ofTarget.set(id, card.product_id);

    plan.entries = idMap.buildPlan({ sources, targetSets, listings, failedSets, products: { ofTarget, known, catalog, bySetNumber } });
    // Keep only the rows apply may have to insert; the listings stay in their own cache.
    plan.targetRows = new Map(plan.entries.filter(e => e.new_id && plan.targetRows.has(e.new_id)).map(e => [e.new_id, plan.targetRows.get(e.new_id)]));
  }
  plan.storage = await storageMoves(plan.entries, plan.targetSets);
  return plan;
}

const MOVES = (e) => e.class === 'mapped' || e.class === 'product';

async function owners(ids) {
  const out = new Map();
  const add = (id, userId, username, key, n) => {
    if (!out.has(id)) out.set(id, new Map());
    const byUser = out.get(id);
    if (!byUser.has(userId)) byUser.set(userId, { user_id: userId, username: username || null, collection_rows: 0, deck_rows: 0 });
    byUser.get(userId)[key] += n;
  };
  for (const r of await selectIn(`SELECT c.card_id AS id, c.user_id, u.username, COUNT(*) AS n FROM collection c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.card_id IN ({in}) GROUP BY c.card_id, c.user_id`, ids)) {
    add(r.id, r.user_id, r.username, 'collection_rows', r.n);
  }
  for (const r of await selectIn(`SELECT dc.card_id AS id, d.user_id, u.username, COUNT(*) AS n FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id LEFT JOIN users u ON u.id = d.user_id WHERE dc.card_id IN ({in}) GROUP BY dc.card_id, d.user_id`, ids)) {
    add(r.id, r.user_id, r.username, 'deck_rows', r.n);
  }
  return new Map([...out].map(([id, byUser]) => [id, [...byUser.values()]]));
}

const tally = () => ({ mapped: 0, product: 0, ambiguous: 0, unmapped: 0 });

// The dry-run report. Counts and ids only: the one piece of user data in it is who
// owns the cards that cannot move, so the admin knows whose binder to check.
async function report(plan) {
  const counts = { total: plan.entries.length, ...tally(), confirmed: 0 };
  const rows = {};
  const sets = new Map();
  for (const e of plan.entries) {
    counts[e.class]++;
    if (e.confirmed) counts.confirmed++;
    const refs = plan.refs.get(e.old_id) || {};
    if (MOVES(e)) for (const [table, n] of Object.entries(refs)) rows[table] = (rows[table] || 0) + n;
    const key = String(e.source.set_id || '').toLowerCase();
    if (!sets.has(key)) sets.set(key, { source_set: e.source.set_id || '', source_name: e.source.set_name || '', targets: new Map(), ...tally() });
    const s = sets.get(key);
    s[e.class]++;
    for (const t of e.new_id ? [e.target.set_id] : e.target_sets) s.targets.set(t, (s.targets.get(t) || 0) + 1);
  }
  const unresolved = plan.entries.filter(e => !MOVES(e));
  const ownedBy = await owners(unresolved.map(e => e.old_id));
  const targetName = new Map(plan.targetSets.map(t => [t.id, t.name]));
  // One example per set first, so a dozen of them show a dozen different sets.
  const moving = plan.entries.filter(MOVES);
  const firstOfSet = new Map();
  for (const e of moving) {
    const key = String(e.source.set_id).toLowerCase();
    if (!firstOfSet.has(key)) firstOfSet.set(key, e);
  }
  const leading = new Set(firstOfSet.values());
  const examples = [...leading, ...moving.filter(e => !leading.has(e))].slice(0, 12)
    .map(e => ({ old_id: e.old_id, new_id: e.new_id, name: e.source.name || e.target.name, method: e.method, confirmed: e.confirmed }));
  const changes = storageChanges(plan.storage);
  const namedInStorage = new Set();
  for (const r of [...plan.storage.locations, ...plan.storage.compartments]) {
    for (const id of idMap.storageSetIds(r.fixed_slots, [r.rule_config])) namedInStorage.add(id.toLowerCase());
  }
  const days = Math.ceil((Date.parse(`${pokemonProvider.POKEMONTCG_SUNSET}T00:00:00Z`) - Date.now()) / 86400000);
  return {
    plan_id: plan.id,
    generated_at: new Date(plan.at).toISOString(),
    sunset: pokemonProvider.POKEMONTCG_SUNSET,
    days_left: Math.max(0, days),
    configured_provider: plan.configured,
    target_provider: plan.target,
    switches_provider: plan.configured !== plan.target,
    counts: { ...counts, migratable: counts.mapped + counts.product },
    rows,
    sets: [...sets.values()].map(s => {
      const [best] = [...s.targets].sort((a, b) => b[1] - a[1]);
      return {
        source_set: s.source_set, source_name: s.source_name,
        target_set: best ? best[0] : null, target_name: best ? targetName.get(best[0]) || null : null,
        mapped: s.mapped, product: s.product, ambiguous: s.ambiguous, unmapped: s.unmapped,
      };
    }).sort((a, b) => a.source_set.localeCompare(b.source_set)),
    examples,
    unresolved: unresolved.map(e => ({
      old_id: e.old_id, class: e.class, reason: e.reason,
      name: e.source.name, set_id: e.source.set_id, set_name: e.source.set_name, number: e.source.number,
      candidates: e.candidates,
      rows: plan.refs.get(e.old_id) || {},
      owners: ownedBy.get(e.old_id) || [],
    })),
    errors: plan.errors,
    storage: {
      changes: changes.length,
      moves: [...plan.storage.moves].filter(([from]) => namedInStorage.has(from)).map(([from, m]) => ({ from, to: m.set_id })),
      blocked: [...plan.storage.blocked].filter(([from]) => namedInStorage.has(from)).map(([from, reason]) => ({ set_id: from, reason })),
    },
  };
}

async function preview() {
  if (busy) throw fail(409, `A migration ${busy} is in progress.`);
  if (!previewing) {
    previewing = computePlan()
      .then(async (plan) => {
        planCache = plan;
        return report(plan);
      })
      .finally(() => { previewing = null; });
  }
  return previewing;
}

// --- apply ---------------------------------------------------------------------

// Two jobs that would fight this one: a catalog build reads card_cache ids it is
// about to write back into a catalog file, and the product-map build opens raw
// BEGIN/COMMIT pairs on the one shared connection, which would commit or roll
// back the middle of this transaction.
function guardJobs() {
  if (require('./catalog').state()) throw fail(409, 'A scan catalog build is running. Wait for it to finish, or stop it, then try again.');
  if (require('./tcgplayerCatalog').state()) throw fail(409, 'The TCGplayer product map is being rebuilt. Try again when it has finished.');
}

function guardIdle() {
  if (busy) throw fail(409, `A migration ${busy} is already running.`);
  if (followUp && !followUp.finished_at) throw fail(409, 'The last migration is still refreshing card details. Try again when it has finished.');
  guardJobs();
}

function journal(runId) {
  return async (rows) => {
    for (const part of chunks(rows, 100)) {
      await db.run(
        `INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id, data)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        part.flatMap(r => [runId, r.tbl, r.action, r.ref == null ? null : String(r.ref), r.old_id || null, r.new_id || null,
          r.data == null ? null : JSON.stringify(r.data)])
      );
    }
  };
}

async function loadMap(entries) {
  await db.run(`DROP TABLE IF EXISTS ${MAP}`);
  // new_id UNIQUE: buildPlan already refuses two old ids landing on one new id,
  // and this makes the transaction refuse it too if anything ever slipped past.
  await db.run(`CREATE TEMP TABLE pokemon_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL UNIQUE, method TEXT NOT NULL)`);
  for (const part of chunks(entries, 300)) {
    await db.run(`INSERT INTO ${MAP} (old_id, new_id, method) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`,
      part.flatMap(e => [e.old_id, e.new_id, e.method]));
  }
}

// A TCGdex set listing is a brief: name, number and art, nothing else. Until the
// row is hydrated it carries the old row's rarity, types and last price instead of
// TCGdex's defaults ('Common', $0.00), stamped stale so every freshness check
// still refetches it. pokemontcgapi.com rows come from a full listing and keep
// their own (unpriced) values, which is what its price refresh selects on.
function interimRow(provider, listed, old) {
  const row = { ...listed };
  if (provider !== pokemonProvider.TCGDEX || !old) return row;
  const subtypes = parseList(old.subtypes);
  const types = parseList(old.types);
  return {
    ...row,
    supertype: old.supertype || row.supertype,
    subtypes: subtypes.length ? subtypes : row.subtypes,
    types: types.length ? types : row.types,
    rarity: old.rarity || row.rarity,
    price_trend: old.price_trend, price_normal: old.price_normal, price_holofoil: old.price_holofoil,
    price_reverse_holofoil: old.price_reverse_holofoil, price_avg1: old.price_avg1, price_avg7: old.price_avg7,
    price_avg30: old.price_avg30, price_currency: old.price_currency || row.price_currency,
    price_source: old.price_source || row.price_source,
    tcgplayer_product_id: old.tcgplayer_product_id || row.tcgplayer_product_id || null,
  };
}

async function insertTargets(plan, live, write, have, old) {
  const rows = live.filter(e => !have.has(e.new_id)).map(e => interimRow(plan.target, plan.targetRows.get(e.new_id), old.get(e.old_id)));
  await cacheNormalizedCards(rows, 'pokemon', { incomplete: true });
  // price_1st_edition is written by TCGCSV only, so the shared writer has no column for it.
  for (const e of live) {
    const o = old.get(e.old_id);
    if (!have.has(e.new_id) && plan.target === pokemonProvider.TCGDEX && o && o.price_1st_edition != null) {
      await db.run(`UPDATE card_cache SET price_1st_edition = ? WHERE id = ?`, [o.price_1st_edition, e.new_id]);
    }
  }
  await write(rows.map(r => ({ tbl: 'card_cache', action: 'insert', ref: r.id, new_id: r.id })));
  return rows.length;
}

async function rekeyCollection(runId) {
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id)
    SELECT ?, 'collection', 'rekey', c.id, c.card_id, m.new_id FROM collection c JOIN ${MAP} m ON m.old_id = c.card_id`, [runId]);
  // Copies are rows, so a target id the user already holds simply gains rows:
  // nothing to merge and no quantity to add up.
  const { changes } = await db.run(`UPDATE collection SET card_id = (SELECT m.new_id FROM ${MAP} m WHERE m.old_id = collection.card_id)
    WHERE card_id IN (SELECT old_id FROM ${MAP})`);
  return { rekeyed: changes };
}

// (deck_id, card_id) is the primary key, so a deck that already lists the target
// card takes the old row's copies onto it — the one place quantities are added,
// because the schema leaves no other way to keep both. Journaled with both
// before-images so an undo can split them again.
async function rekeyDeckCards(runId) {
  const pairs = `FROM deck_cards o JOIN ${MAP} m ON m.old_id = o.card_id JOIN deck_cards n ON n.deck_id = o.deck_id AND n.card_id = m.new_id`;
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id, data)
    SELECT ?, 'deck_cards', 'merge', o.deck_id, o.card_id, m.new_id,
           json_object('old_quantity', o.quantity, 'old_checked_out', o.checked_out, 'new_quantity', n.quantity, 'new_checked_out', n.checked_out)
    ${pairs}`, [runId]);
  const merged = await db.all(`SELECT o.deck_id, m.new_id, COALESCE(o.quantity, 1) AS qty, COALESCE(o.checked_out, 0) AS co ${pairs}`);
  for (const r of merged) {
    await db.run(`UPDATE deck_cards SET quantity = COALESCE(quantity, 1) + ?, checked_out = MAX(COALESCE(checked_out, 0), ?)
      WHERE deck_id = ? AND card_id = ?`, [r.qty, r.co, r.deck_id, r.new_id]);
  }
  await db.run(`DELETE FROM deck_cards WHERE card_id IN (SELECT old_id FROM ${MAP})
    AND EXISTS (SELECT 1 FROM ${MAP} m JOIN deck_cards n ON n.card_id = m.new_id
                 WHERE m.old_id = deck_cards.card_id AND n.deck_id = deck_cards.deck_id)`);
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id)
    SELECT ?, 'deck_cards', 'rekey', o.deck_id, o.card_id, m.new_id FROM deck_cards o JOIN ${MAP} m ON m.old_id = o.card_id`, [runId]);
  const { changes } = await db.run(`UPDATE deck_cards SET card_id = (SELECT m.new_id FROM ${MAP} m WHERE m.old_id = deck_cards.card_id)
    WHERE card_id IN (SELECT old_id FROM ${MAP})`);
  return { rekeyed: changes, merged: merged.length };
}

// History follows the card. The target's own points are journaled by timestamp
// rather than every moved point (a collection's history runs to hundreds of
// thousands of rows): an undo moves back whatever predates the run and is not one
// of those. Two points at one instant keep the target's and journal the other.
async function rekeyPriceHistory(runId) {
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, new_id)
    SELECT ?, 'price_history', 'keep', p.recorded_at, p.card_id FROM price_history p WHERE p.card_id IN (SELECT new_id FROM ${MAP})`, [runId]);
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id, data)
    SELECT ?, 'price_history', 'drop', o.recorded_at, o.card_id, m.new_id, json_object('price', o.price, 'currency', o.currency)
      FROM price_history o JOIN ${MAP} m ON m.old_id = o.card_id
     WHERE EXISTS (SELECT 1 FROM price_history n WHERE n.card_id = m.new_id AND n.recorded_at = o.recorded_at)`, [runId]);
  const { changes: dropped } = await db.run(`DELETE FROM price_history WHERE card_id IN (SELECT old_id FROM ${MAP})
    AND EXISTS (SELECT 1 FROM ${MAP} m JOIN price_history n ON n.card_id = m.new_id
                 WHERE m.old_id = price_history.card_id AND n.recorded_at = price_history.recorded_at)`);
  const { changes: moved } = await db.run(`UPDATE price_history SET card_id = (SELECT m.new_id FROM ${MAP} m WHERE m.old_id = price_history.card_id)
    WHERE card_id IN (SELECT old_id FROM ${MAP})`);
  return { moved, dropped };
}

// Derived, one row per card: a target that already has its own mapping keeps it.
async function rekeyProductMap(runId) {
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id, data)
    SELECT ?, 'tcgplayer_product', 'drop', o.card_id, o.card_id, m.new_id,
           json_object('product_id', o.product_id, 'category_id', o.category_id, 'confidence', o.confidence, 'matched_at', o.matched_at)
      FROM tcgplayer_product o JOIN ${MAP} m ON m.old_id = o.card_id
     WHERE EXISTS (SELECT 1 FROM tcgplayer_product n WHERE n.card_id = m.new_id)`, [runId]);
  const { changes: dropped } = await db.run(`DELETE FROM tcgplayer_product WHERE card_id IN (SELECT old_id FROM ${MAP})
    AND EXISTS (SELECT 1 FROM ${MAP} m JOIN tcgplayer_product n ON n.card_id = m.new_id WHERE m.old_id = tcgplayer_product.card_id)`);
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id)
    SELECT ?, 'tcgplayer_product', 'rekey', o.card_id, o.card_id, m.new_id FROM tcgplayer_product o JOIN ${MAP} m ON m.old_id = o.card_id`, [runId]);
  const { changes: rekeyed } = await db.run(`UPDATE tcgplayer_product SET card_id = (SELECT m.new_id FROM ${MAP} m WHERE m.old_id = tcgplayer_product.card_id)
    WHERE card_id IN (SELECT old_id FROM ${MAP})`);
  return { rekeyed, dropped };
}

async function rekeyGeneric(runId, { table, column, key }) {
  const t = ident(table), c = ident(column);
  try {
    await db.get(`SELECT rowid FROM ${t} LIMIT 1`);
  } catch {
    throw fail(500, `${key} holds card ids in a table without rowids, which this migration cannot journal. Nothing was changed.`);
  }
  await db.run(`INSERT INTO pokemon_id_migration_undo (run_id, tbl, action, ref, old_id, new_id)
    SELECT ?, ?, 'rekey', x.rowid, x.${c}, m.new_id FROM ${t} x JOIN ${MAP} m ON m.old_id = x.${c}`, [runId, key]);
  const { changes } = await db.run(`UPDATE ${t} SET ${c} = (SELECT m.new_id FROM ${MAP} m WHERE m.old_id = ${t}.${c})
    WHERE ${c} IN (SELECT old_id FROM ${MAP})`);
  return { rekeyed: changes };
}

const REKEY = {
  'collection.card_id': rekeyCollection,
  'deck_cards.card_id': rekeyDeckCards,
  'price_history.card_id': rekeyPriceHistory,
  'tcgplayer_product.card_id': rekeyProductMap,
};

// The old id's art follows it when the new id has none, layer and all: art an
// admin uploaded, or art contributed to the repo for that id, is what this card
// was shown with. Copied, not moved, so an undo only has to delete the copy.
async function copyArt(live, write, copied) {
  const rows = [];
  for (const e of live) {
    const from = cardArt.resolve(e.old_id);
    if (!from || !cardArt.isValidId(e.new_id) || cardArt.resolve(e.new_id)) continue;
    fs.mkdirSync(cardArt.USER_DIR, { recursive: true });
    const to = path.join(cardArt.USER_DIR, `${e.new_id}.png`);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    copied.push(to);
    rows.push({ tbl: 'card_art', action: 'copy', ref: e.new_id, old_id: e.old_id, new_id: e.new_id, data: { sha256: sha256(to) } });
  }
  await write(rows);
  return rows.length;
}

async function rewriteStorage(plan, write) {
  // Re-read inside the transaction: the plan's copy is as old as the preview.
  const storage = { ...plan.storage, ...await storageRows() };
  const changes = storageChanges(storage);
  await write(changes.map(ch => ({ tbl: ch.table, action: 'config', ref: ch.id, data: { column: ch.column, before: ch.before, after: ch.after } })));
  for (const ch of changes) {
    // Table and column names come from storageChanges' fixed list, never from input.
    await db.run(`UPDATE ${ch.table} SET ${ch.column} = ? WHERE id = ?`, [ch.after, ch.id]);
  }
  return changes.length;
}

async function rekey(plan, entries, snapshot, configured) {
  const copied = [];
  try {
    return await db.withTransaction(async () => {
      // Checked again here, not just before the backup: anything that changed in
      // between is what this transaction actually sees.
      const columns = await cardIdColumns();
      const refs = await legacyReferences(columns);
      const referenced = entries.filter(e => refs.has(e.old_id));
      const have = new Set((await selectIn(`SELECT id FROM card_cache WHERE id IN ({in})`, referenced.map(e => e.new_id))).map(r => r.id));
      const live = referenced.filter(e => have.has(e.new_id) || plan.targetRows.has(e.new_id));
      if (!live.length) return null;

      const startedAt = (await db.get(`SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS t`)).t;
      const switching = configured !== plan.target;
      const { lastID: runId } = await db.run(
        `INSERT INTO pokemon_id_migration_runs (target_provider, previous_provider, backup_file, started_at) VALUES (?, ?, ?, ?)`,
        [plan.target, configured, snapshot ? snapshot.file : null, startedAt]
      );
      const write = journal(runId);
      await loadMap(live);
      const old = new Map((await selectIn(`SELECT * FROM card_cache WHERE id IN ({in})`, live.map(e => e.old_id))).map(r => [r.id, r]));

      const summary = { ids: live.length, card_cache: { inserted: await insertTargets(plan, live, write, have, old), removed: 0 } };
      for (const col of columns) {
        summary[REKEY[col.key] ? col.table : col.key] = await (REKEY[col.key] ? REKEY[col.key](runId) : rekeyGeneric(runId, col));
      }
      // The old rows go last, once nothing points at them: they would otherwise
      // keep answering local searches and scans with ids the provider is retiring.
      const newOf = new Map(live.map(e => [e.old_id, e.new_id]));
      await write([...old.values()].map(r => ({ tbl: 'card_cache', action: 'drop', ref: r.id, old_id: r.id, new_id: newOf.get(r.id), data: r })));
      summary.card_cache.removed = (await db.run(`DELETE FROM card_cache WHERE id IN (SELECT old_id FROM ${MAP})`)).changes;
      summary.storage = await rewriteStorage(plan, write);
      if (switching) await db.run(`UPDATE app_settings SET pokemon_provider = ? WHERE id = 1`, [plan.target]);
      summary.switched_provider = switching;
      await db.run(`INSERT INTO pokemon_id_migration_log (run_id, old_id, new_id, method) SELECT ?, old_id, new_id, method FROM ${MAP}`, [runId]);
      summary.by_method = Object.fromEntries(['set-number', 'product-id'].map(m => [m, live.filter(e => e.method === m).length]));
      summary.card_art = await copyArt(live, write, copied);
      await db.run(`UPDATE pokemon_id_migration_runs SET summary = ? WHERE id = ?`, [JSON.stringify(summary), runId]);
      await db.run(`DROP TABLE IF EXISTS ${MAP}`);
      return { runId, switching };
    });
  } catch (e) {
    // The transaction rolled back; files are not part of it.
    for (const file of copied) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    throw e;
  }
}

function runInfo(row) {
  if (!row) return null;
  const json = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: row.id, target_provider: row.target_provider, previous_provider: row.previous_provider,
    backup_file: row.backup_file, applied_at: row.applied_at, reverted_at: row.reverted_at,
    summary: json(row.summary), revert_summary: json(row.revert_summary),
  };
}
const loadRun = async (id) => runInfo(await db.get(`SELECT * FROM pokemon_id_migration_runs WHERE id = ?`, [id]));

async function apply(planId, { background = true } = {}) {
  const plan = planCache && planCache.id === planId ? planCache : null;
  // Pressing the button twice is not a second migration — and is not an error,
  // even while the first one is still refreshing card details.
  if (plan && plan.applied) return { already_applied: true, run: await loadRun(plan.applied), follow_up: followUpState() };
  guardIdle();
  if (!plan || Date.now() - plan.at > PLAN_TTL_MS) {
    throw fail(409, 'That preview has expired or was replaced. Run the preview again and confirm the new numbers.');
  }
  const configured = await pokemonProvider.configured();
  if (pokemonProvider.migrationTarget(configured) !== plan.target) {
    throw fail(409, 'The Pokémon provider changed since the preview. Run the preview again.');
  }
  busy = 'apply';
  let done;
  try {
    const moving = plan.entries.filter(e => MOVES(e));
    const refs = await legacyReferences(await cardIdColumns());
    if (!moving.some(e => refs.has(e.old_id))) {
      done = null;
    } else {
      // A file-level copy first, from the backup module the Admin button uses.
      // Taken before the transaction because VACUUM INTO cannot run inside one,
      // and if it fails nothing has been touched.
      const snapshot = await backup.createBackup();
      done = await rekey(plan, moving, snapshot, configured);
    }
  } finally {
    busy = null;
  }
  if (!done) {
    // Nothing left to move. Still finish what an interrupted earlier run left
    // undone (catalog ids, card details), which is what makes re-running safe.
    const state = startFollowUp({ runId: null, provider: plan.target, switched: false });
    if (!background) await state.promise;
    return { noop: true, run: null, follow_up: followUpState() };
  }
  plan.applied = done.runId;
  planCache = plan;
  cardArt.invalidate();
  const state = startFollowUp({ runId: done.runId, provider: plan.target, switched: done.switching });
  if (!background) await state.promise;
  return { run: await loadRun(done.runId), follow_up: followUpState() };
}

// --- after commit ----------------------------------------------------------------

// Ids every applied, not-undone run moved, as old -> new.
async function appliedPairs() {
  const rows = await db.all(`SELECT l.old_id, l.new_id FROM pokemon_id_migration_log l
    JOIN pokemon_id_migration_runs r ON r.id = l.run_id WHERE r.reverted_at IS NULL`);
  return new Map(rows.map(r => [r.old_id, r.new_id]));
}

// The local English scan catalog is keyed by card_cache id, so a moved card's
// vector would otherwise win a scan and then resolve to no card. Only the id list
// is rewritten — the vectors are the same artwork — and it is one file, renamed
// into place, so an interruption leaves the old list rather than half a new one.
// A target that already had its own vector ends up listed twice, which the scan
// dedupes and the next rebuild collapses.
function rekeyCatalogIds(pairs) {
  if (!pairs.size) return 0;
  const catalog = require('./catalog');
  const file = catalog.metaPath('pokemon', 'English');
  if (!fs.existsSync(file)) return 0;
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(meta.ids)) return 0;
  const srcs = meta.srcs || {};
  let n = 0;
  meta.ids = meta.ids.map((id) => {
    const to = pairs.get(id);
    if (!to) return id;
    n++;
    if (srcs[id] !== undefined) {
      if (srcs[to] === undefined) srcs[to] = srcs[id];
      delete srcs[id];
    }
    return to;
  });
  if (!n) return 0;
  meta.srcs = srcs;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta));
  fs.renameSync(`${file}.tmp`, file);
  require('./cvScan').reload('pokemon', 'English');
  return n;
}

// Moved cards that are owned or decked and whose rows are still the interim copy
// (stamped 1970) or unpriced. Hydrated rows drop out, so this re-runs as a no-op.
async function hydrationTargets() {
  return (await db.all(`SELECT DISTINCT l.new_id AS id FROM pokemon_id_migration_log l
      JOIN pokemon_id_migration_runs r ON r.id = l.run_id AND r.reverted_at IS NULL
      JOIN card_cache cc ON cc.id = l.new_id
     WHERE (l.new_id IN (SELECT card_id FROM collection) OR l.new_id IN (SELECT card_id FROM deck_cards))
       AND (cc.supertype IS NULL OR cc.supertype = '' OR cc.price_trend IS NULL OR cc.last_updated < '1970-01-02')
     ORDER BY l.new_id`)).map(r => r.id);
}

// The same follow-up routes/settings.js runs when the provider is switched there:
// the set list, the sort cache and the product map are all numbered by provider.
async function providerFollowUp(provider) {
  await pokemonProvider.clientFor(provider).fetchAndCacheSets(true);
  await require('./utils/compartmentSort').loadSetsCache(db);
  try { require('./tcgplayerCatalog').start(); } catch { /* already building, which is what was wanted */ }
}

function startFollowUp({ runId, provider, switched }) {
  const state = { run_id: runId, phase: 'catalog', done: 0, total: 0, failed: 0, catalog: 0, message: '', started_at: new Date().toISOString(), finished_at: null };
  followUp = state;
  state.promise = (async () => {
    try {
      state.catalog = rekeyCatalogIds(await appliedPairs());
      state.phase = 'hydrating';
      const ids = await hydrationTargets();
      state.total = ids.length;
      // Card details through the provider that owns each id (cardApi), with one
      // exception: pokemontcgapi.com's per-card fetch costs two credits, and a
      // batched priced listing about a sixth of one, for the same rows.
      const metered = ids.filter(id => cardApi.isPokemontcgapiId(id));
      await mapLimited(ids.filter(id => !cardApi.isPokemontcgapiId(id)), HYDRATE_CONCURRENCY, async (id) => {
        await cardApi.hydrate(id);
        const row = await db.get(`SELECT last_updated FROM card_cache WHERE id = ?`, [id]);
        if (!row || String(row.last_updated) < '1970-01-02') state.failed++;
        state.done++;
      });
      if (metered.length) {
        try { await require('./pokemontcgapi').refreshPrices(metered); }
        catch (e) { state.failed += metered.length; state.message = e.message; }
        state.done += metered.length;
      }
      // English TCGdex rows take their USD prices from TCGCSV, like every other
      // English TCGdex card; the sweep reads its local cache, so forcing it is cheap.
      if (ids.length && provider === pokemonProvider.TCGDEX) {
        state.phase = 'pricing';
        await require('./tcgcsvApi').updateCollectionPrices(true);
      }
      if (switched) {
        state.phase = 'sets';
        await providerFollowUp(provider);
      }
      state.phase = 'done';
    } catch (e) {
      state.phase = 'error';
      state.message = e.message;
      console.error(`Pokémon id migration follow-up failed: ${e.message}`);
    } finally {
      state.finished_at = new Date().toISOString();
    }
  })();
  return state;
}

function followUpState() {
  if (!followUp) return null;
  const { promise, ...state } = followUp; // eslint-disable-line no-unused-vars
  return state;
}

// For tests and the route: resolves when the background follow-up is done.
const idle = () => (followUp ? followUp.promise : Promise.resolve());

// --- revert ----------------------------------------------------------------------

async function undoRows(runId, tbl, action) {
  return db.all(`SELECT * FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = ? AND action = ? ORDER BY id`, [runId, tbl, action]);
}

// Re-point rows journaled by rowid, where they still hold the id this run gave
// them. A temp table keyed by rowid keeps it one indexed pass on any size.
async function undoByRowid(table, column, runId, tbl) {
  await db.run(`DROP TABLE IF EXISTS temp.pokemon_id_undo_rows`);
  await db.run(`CREATE TEMP TABLE pokemon_id_undo_rows (ref INTEGER PRIMARY KEY, old_id TEXT, new_id TEXT)`);
  await db.run(`INSERT OR IGNORE INTO temp.pokemon_id_undo_rows (ref, old_id, new_id)
    SELECT CAST(ref AS INTEGER), old_id, new_id FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = ? AND action = 'rekey'`, [runId, tbl]);
  const t = ident(table), c = ident(column);
  const { changes } = await db.run(`UPDATE ${t} SET ${c} = (SELECT u.old_id FROM temp.pokemon_id_undo_rows u WHERE u.ref = ${t}.rowid)
    WHERE rowid IN (SELECT ref FROM temp.pokemon_id_undo_rows)
      AND ${c} = (SELECT u.new_id FROM temp.pokemon_id_undo_rows u WHERE u.ref = ${t}.rowid)`);
  const { n } = await db.get(`SELECT COUNT(*) AS n FROM temp.pokemon_id_undo_rows`);
  await db.run(`DROP TABLE temp.pokemon_id_undo_rows`);
  return { restored: changes, skipped: n - changes };
}

async function undoDeckCards(runId) {
  let restored = 0, skipped = 0;
  const rows = await db.all(`SELECT * FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = 'deck_cards' ORDER BY id`, [runId]);
  for (const u of rows) {
    const deckId = Number(u.ref);
    const cur = await db.get(`SELECT quantity, checked_out FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, u.new_id]);
    if (!cur) { skipped++; continue; }
    const q = cur.quantity == null ? 1 : cur.quantity;
    let oldQty = q, newQty = 0, oldOut = cur.checked_out, newOut = cur.checked_out;
    if (u.action === 'merge') {
      // Split the merged row back: the old row's copies first, the rest stays.
      // Exact when nothing changed since; never more copies than the row holds.
      const d = JSON.parse(u.data);
      oldQty = Math.min(d.old_quantity == null ? 1 : d.old_quantity, q);
      newQty = q - oldQty;
      oldOut = d.old_checked_out;
      newOut = d.new_checked_out;
    }
    if (oldQty > 0) {
      await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, ?, ?, ?)
        ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = COALESCE(quantity, 1) + excluded.quantity`, [deckId, u.old_id, oldQty, oldOut]);
    }
    if (newQty > 0) {
      await db.run(`UPDATE deck_cards SET quantity = ?, checked_out = ? WHERE deck_id = ? AND card_id = ?`, [newQty, newOut, deckId, u.new_id]);
    } else {
      await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, u.new_id]);
    }
    restored++;
  }
  return { restored, skipped };
}

async function undoPriceHistory(runId, startedAt) {
  const { changes: reinserted } = await db.run(`INSERT OR IGNORE INTO price_history (card_id, price, currency, recorded_at)
    SELECT old_id, json_extract(data, '$.price'), json_extract(data, '$.currency'), ref
      FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = 'price_history' AND action = 'drop'`, [runId]);
  await db.run(`DROP TABLE IF EXISTS temp.pokemon_id_undo_keep`);
  await db.run(`CREATE TEMP TABLE pokemon_id_undo_keep (card_id TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (card_id, recorded_at))`);
  await db.run(`INSERT OR IGNORE INTO temp.pokemon_id_undo_keep (card_id, recorded_at)
    SELECT new_id, ref FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = 'price_history' AND action = 'keep'`, [runId]);
  // Points recorded after the run belong to the new id; julianday() so the
  // second- and millisecond-resolution timestamps compare as times, not strings.
  const { changes: moved } = await db.run(`UPDATE OR IGNORE price_history
       SET card_id = (SELECT l.old_id FROM pokemon_id_migration_log l WHERE l.run_id = ? AND l.new_id = price_history.card_id)
     WHERE card_id IN (SELECT new_id FROM pokemon_id_migration_log WHERE run_id = ?)
       AND julianday(recorded_at) < julianday(?)
       AND NOT EXISTS (SELECT 1 FROM temp.pokemon_id_undo_keep k WHERE k.card_id = price_history.card_id AND k.recorded_at = price_history.recorded_at)`,
  [runId, runId, startedAt]);
  await db.run(`DROP TABLE temp.pokemon_id_undo_keep`);
  return { moved, reinserted };
}

async function undoProductMap(runId) {
  await db.run(`DROP TABLE IF EXISTS temp.pokemon_id_undo_ids`);
  await db.run(`CREATE TEMP TABLE pokemon_id_undo_ids (new_id TEXT PRIMARY KEY, old_id TEXT NOT NULL)`);
  await db.run(`INSERT OR IGNORE INTO temp.pokemon_id_undo_ids (new_id, old_id)
    SELECT new_id, old_id FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = 'tcgplayer_product' AND action = 'rekey'`, [runId]);
  const { changes: rekeyed } = await db.run(`UPDATE OR IGNORE tcgplayer_product
       SET card_id = (SELECT u.old_id FROM temp.pokemon_id_undo_ids u WHERE u.new_id = tcgplayer_product.card_id)
     WHERE card_id IN (SELECT new_id FROM temp.pokemon_id_undo_ids)`);
  await db.run(`DROP TABLE temp.pokemon_id_undo_ids`);
  const { changes: reinserted } = await db.run(`INSERT OR IGNORE INTO tcgplayer_product (card_id, product_id, category_id, confidence, matched_at)
    SELECT old_id, json_extract(data, '$.product_id'), json_extract(data, '$.category_id'), json_extract(data, '$.confidence'), json_extract(data, '$.matched_at')
      FROM pokemon_id_migration_undo WHERE run_id = ? AND tbl = 'tcgplayer_product' AND action = 'drop'`, [runId]);
  return { rekeyed, reinserted };
}

// Storage settings go back only where nobody has edited them since.
async function undoStorage(runId) {
  let restored = 0, skipped = 0;
  for (const tbl of ['locations', 'compartments']) {
    for (const u of await undoRows(runId, tbl, 'config')) {
      const { column, before, after } = JSON.parse(u.data);
      if (!['fixed_slots', 'rule_config'].includes(column)) continue;
      const { changes } = await db.run(`UPDATE ${tbl} SET ${column} = ? WHERE id = ? AND ${column} IS ?`, [before, Number(u.ref), after]);
      if (changes) restored++; else skipped++;
    }
  }
  return { restored, skipped };
}

async function undoInTransaction(run) {
  return db.withTransaction(async () => {
    const runId = run.id;
    const out = {};
    // card_cache first: everything below points back at these rows.
    const cols = new Set((await db.all(`PRAGMA table_info(card_cache)`)).map(c => c.name));
    let restoredRows = 0;
    for (const u of await undoRows(runId, 'card_cache', 'drop')) {
      const row = JSON.parse(u.data);
      const keys = Object.keys(row).filter(k => cols.has(k));
      restoredRows += (await db.run(`INSERT OR IGNORE INTO card_cache (${keys.map(ident).join(', ')}) VALUES (${marks(keys.length)})`, keys.map(k => row[k]))).changes;
    }
    out.card_cache = { restored: restoredRows, removed: 0 };
    const columns = await cardIdColumns();
    for (const col of columns) {
      if (col.key === 'collection.card_id') out.collection = await undoByRowid('collection', 'card_id', runId, 'collection');
      else if (col.key === 'deck_cards.card_id') out.deck_cards = await undoDeckCards(runId);
      else if (col.key === 'price_history.card_id') out.price_history = await undoPriceHistory(runId, run.started_at);
      else if (col.key === 'tcgplayer_product.card_id') out.tcgplayer_product = await undoProductMap(runId);
      else out[col.table] = await undoByRowid(col.table, col.column, runId, col.key);
    }
    out.storage = await undoStorage(runId);
    const current = await pokemonProvider.configured();
    out.restored_provider = false;
    if (run.previous_provider && run.previous_provider !== run.target_provider && current === run.target_provider) {
      await db.run(`UPDATE app_settings SET pokemon_provider = ? WHERE id = 1`, [run.previous_provider]);
      out.restored_provider = true;
    }
    // Rows this run created go again unless something has come to point at them.
    const unreferenced = columns.map(c => `NOT EXISTS (SELECT 1 FROM ${ident(c.table)} WHERE ${ident(c.column)} = card_cache.id)`).join(' AND ');
    for (const u of await undoRows(runId, 'card_cache', 'insert')) {
      out.card_cache.removed += (await db.run(`DELETE FROM card_cache WHERE id = ?${unreferenced ? ` AND ${unreferenced}` : ''}`, [u.new_id])).changes;
    }
    await db.run(`UPDATE pokemon_id_migration_runs SET reverted_at = CURRENT_TIMESTAMP, revert_summary = ? WHERE id = ?`, [JSON.stringify(out), runId]);
    return out;
  });
}

async function revert(runId = null) {
  guardIdle();
  const run = runId
    ? await db.get(`SELECT * FROM pokemon_id_migration_runs WHERE id = ?`, [runId])
    : await db.get(`SELECT * FROM pokemon_id_migration_runs WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1`);
  if (!run) throw fail(404, 'There is no applied migration to undo.');
  if (run.reverted_at) throw fail(409, `Migration #${run.id} was already undone.`);
  const later = await db.get(`SELECT id FROM pokemon_id_migration_runs WHERE id > ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1`, [run.id]);
  if (later) throw fail(409, `Undo migration #${later.id} first: migrations are undone newest first.`);
  busy = 'revert';
  let out;
  try {
    const snapshot = await backup.createBackup();
    out = await undoInTransaction(run);
    out.backup_file = snapshot ? snapshot.file : null;
  } finally {
    busy = null;
  }
  // After commit: files. The art copies go only if they are still the bytes this
  // run wrote; an admin may have replaced one since.
  let art = 0;
  for (const u of await undoRows(run.id, 'card_art', 'copy')) {
    const file = path.join(cardArt.USER_DIR, `${u.new_id}.png`);
    try {
      if (fs.existsSync(file) && sha256(file) === JSON.parse(u.data).sha256) { fs.unlinkSync(file); art++; }
    } catch { /* leave it: an extra art file is harmless */ }
  }
  cardArt.invalidate();
  out.card_art = art;
  const created = new Set((await undoRows(run.id, 'card_cache', 'insert')).map(u => u.new_id));
  const back = new Map((await db.all(`SELECT old_id, new_id FROM pokemon_id_migration_log WHERE run_id = ?`, [run.id]))
    .filter(r => created.has(r.new_id)).map(r => [r.new_id, r.old_id]));
  try { out.catalog = rekeyCatalogIds(back); } catch (e) { out.catalog = 0; console.warn(`Catalog ids not restored: ${e.message}`); }
  planCache = null; // a preview from before the undo no longer describes the data
  await db.run(`UPDATE pokemon_id_migration_runs SET revert_summary = ? WHERE id = ?`, [JSON.stringify(out), run.id]);
  // Switching back re-numbers the set list and product map the same way switching
  // forward did.
  if (out.restored_provider) startFollowUp({ runId: null, provider: run.previous_provider, switched: true });
  return { reverted: await loadRun(run.id), follow_up: followUpState() };
}

// --- status ----------------------------------------------------------------------

// Cheap enough for every Admin and Dashboard load: local queries only, no provider.
async function status() {
  const configured = await pokemonProvider.configured();
  const rows = await db.all(`SELECT c.card_id AS id, c.user_id, COUNT(*) AS n FROM collection c
      JOIN card_cache cc ON cc.id = c.card_id
     WHERE cc.game = 'pokemon' AND c.card_id NOT LIKE 'tcgdex-%' AND c.card_id NOT LIKE 'pokemontcgapi-%'
     GROUP BY c.card_id, c.user_id`);
  const decks = await db.all(`SELECT dc.card_id AS id, COUNT(*) AS n FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
     WHERE COALESCE(d.game, 'pokemon') = 'pokemon' AND dc.card_id NOT LIKE 'tcgdex-%' AND dc.card_id NOT LIKE 'pokemontcgapi-%'
     GROUP BY dc.card_id`);
  const legacy = rows.filter(r => idMap.isLegacyId(r.id));
  const legacyDecks = decks.filter(r => idMap.isLegacyId(r.id));
  const ids = new Set([...legacy.map(r => r.id), ...legacyDecks.map(r => r.id)]);
  const runs = await db.all(`SELECT * FROM pokemon_id_migration_runs ORDER BY id DESC LIMIT 5`);
  const days = Math.ceil((Date.parse(`${pokemonProvider.POKEMONTCG_SUNSET}T00:00:00Z`) - Date.now()) / 86400000);
  return {
    sunset: pokemonProvider.POKEMONTCG_SUNSET,
    days_left: Math.max(0, days),
    configured_provider: configured,
    target_provider: pokemonProvider.migrationTarget(configured),
    pending: {
      ids: ids.size,
      collection_rows: legacy.reduce((n, r) => n + r.n, 0),
      deck_rows: legacyDecks.reduce((n, r) => n + r.n, 0),
      users: new Set(legacy.map(r => r.user_id)).size,
    },
    running: busy,
    follow_up: followUpState(),
    runs: runs.map(runInfo),
    plan: planCache && !planCache.applied ? { plan_id: planCache.id, generated_at: new Date(planCache.at).toISOString() } : null,
  };
}

// Tests reset module state between scenarios.
function _reset() {
  planCache = null;
  previewing = null;
  busy = null;
  followUp = null;
  listingCache.clear();
}

module.exports = { preview, apply, revert, status, idle, cardIdColumns, rekeyCatalogIds, _reset, PLAN_TTL_MS };
