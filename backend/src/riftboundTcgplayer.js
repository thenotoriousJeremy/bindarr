// The Riftbound sets RiftCodex does not have, served from TCGplayer's catalogue.
//
// RiftCodex (riftcodexApi.js) stays Riftbound's source: rules text, stats, domains,
// Riot's own art. But it lags the game. On 2026-11-16 it listed eight sets, the
// newest Vendetta, while TCGplayer already sold Radiance (released 2026-10-23, 246
// cards), the K/DA Couture Collection, the T1 Worlds bundles and more (#181).
// TCGplayer's Riftbound catalogue is TCGCSV category 89, which the install already
// syncs for Riftbound prices (riftboundPrices.js), so a TCGplayer group RiftCodex has
// no set for is written into card_cache from that cache: no request of its own, on a
// server or a phone.
//
// CARD IDS are RiftCodex's own, worked out from TCGplayer's collector number, so that
// when RiftCodex adds the set its rows land on the same ids and take over without one
// collection, deck, list or trade being renumbered. The two agree: checked against
// every RiftCodex card that names a TCGplayer product on 2026-11-16, 1,213 of 1,224
// codes come out the same (the rest are RiftCodex filing a TCGplayer bundle's cards
// under PR):
//
//   group RAD, Number '061a/167'  ->  riftbound_id 'rad-061a-167'  ->  riftbound-rad-061a-167
//   group RAD, Number '179*/167'  ->  'rad-179*-167'               ->  riftbound-rad-179.2a-167
//   group RAD, Number 'R02'       ->  'rad-r02'                    ->  riftbound-rad-r02
//
// The set code is TCGplayer's abbreviation, which for every set both of them list is
// RiftCodex's set code (UNL, OGN, VEN...): tcgcsvGameApi.setCodes, the same codes the
// TCGplayer-catalogue games use.
//
// Two products on one Number are told apart the way riftcodexApi tells its records
// apart: the one with no printing marker in its name ('(Metal)', '(Signature)'), then
// the oldest product, keeps the plain id, and every other gets '~tcgp<productId>' —
// which never looks like a RiftCodex record id. A Number of any other shape (a
// double-sided token's 'T02 // T05', a bundle's 'T1S 001/005') gets
// '<set>-tcgp<productId>': stable, unique, and nothing RiftCodex mints. The ids are a
// function of TCGplayer's data alone, never of what this install did before, so a scan
// catalog built elsewhere (scripts/scan-catalogs/build.mjs) names the same cards.
//
// WHICH GROUPS. A group whose set RiftCodex serves cards in is RiftCodex's, and nothing
// is written for it; nor a product RiftCodex serves under another set (it files the
// 2025 Worlds Bundle's cards under PR), nor sealed product. Which sets RiftCodex serves
// is recorded at each of its catalogue refreshes (noteRiftcodex). When a refresh
// brings a set this module wrote, the set is RiftCodex's from then on (takeOver): its
// rows replace these on the shared ids, and a fallback card it does not have goes —
// unless a collection, deck, list, recipe or trade refers to it, and then it stays as
// it was.
//
// What a row carries is what the TCGCSV cache keeps of a product (utils/tcgcsvSlim):
// name, number, rarity, TCGplayer's picture, its card type, domains, tags and stats
// (classify), and its product id, which is what prices it (riftboundPrices.js, the
// same sweep as every other Riftbound card). No rules text, artist or flavour.
'use strict';

const db = require('./db');
const tcgcsv = require('./tcgcsvApi');
const tcgcsvGames = require('./tcgcsvGameApi');
const riftcodex = require('./riftcodexApi');
const { quotesByProduct, CATEGORY_ID } = require('./riftboundPrices');
const { productImageUrl } = require('./utils/tcgcsvSlim');
const { cacheNormalizedCards } = require('./utils/cardCache');
const { referencingTables, deleteUnreferenced } = require('./utils/cardReferences');

const GAME = 'riftbound';
const SET_PREFIX = 'riftbound-';
const STATE_KEY = 'riftbound-fallback';
// Part of the stamp below: bumping it rewrites every install's rows once, for a
// change in what a row holds.
const FORMAT = 1;

// --- ids ---------------------------------------------------------------------

// TCGplayer's collector number as the rest of a RiftCodex riftbound_id, or null for
// a shape RiftCodex's codes do not take.
//   '061a/167' -> '061a-167'   '229*/219' -> '229*-219'   'R02a' -> 'r02a'   'SP4/005' -> 'sp4-005'
//   'T02 // T05', 'T1S 001/005' -> null
function codeTail(number) {
  const m = /^([a-z0-9]+\*?)(?:\/([a-z0-9]+))?$/.exec(String(number ?? '').trim().toLowerCase());
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

// What a card shows as its number when the Number has no RiftCodex shape: the part
// before the set size, lower-cased as RiftCodex's are ('t02 // t05', 't1s 001').
function looseNumber(number) {
  const s = String(number ?? '').trim().toLowerCase();
  return s.includes('//') ? s : s.split('/')[0].trim();
}

const variantFor = (productId) => `tcgp${productId}`;

// One group's numbered products -> Map productId -> { id, number }. Pure: the same
// products give the same ids whatever order they come in, and whatever else the
// install holds.
function assignIds(code, products) {
  const out = new Map();
  const byCode = new Map();
  for (const p of products) {
    const tail = codeTail(p.number);
    if (!tail) {
      const riftboundId = `${code}-${variantFor(p.productId)}`;
      out.set(p.productId, { id: riftcodex.cardIdFor(riftboundId), number: looseNumber(p.number) });
      continue;
    }
    const riftboundId = `${code}-${tail}`;
    if (!byCode.has(riftboundId)) byCode.set(riftboundId, []);
    byCode.get(riftboundId).push(p);
  }
  for (const [riftboundId, group] of byCode) {
    // riftcodexApi's canonical printing: no printing marker in the name, then the
    // oldest record (here, the lowest product id).
    group.sort((a, b) => ((riftcodex.hasPrintingMarker(a.name) ? 1 : 0) - (riftcodex.hasPrintingMarker(b.name) ? 1 : 0))
      || (a.productId - b.productId));
    group.forEach((p, i) => out.set(p.productId, {
      id: riftcodex.cardIdFor(riftboundId, i === 0 ? null : variantFor(p.productId)),
      number: riftcodex.numberOf(riftboundId),
    }));
  }
  return out;
}

// --- rows --------------------------------------------------------------------

const isCard = (p) => p && p.number != null && String(p.number).trim() !== '';

// TCGplayer's rarities are RiftCodex's (Common ... Showcase, Promo), plus 'None' on
// a few tokens, which RiftCodex would call Common.
const rarityOf = (r) => (r && r !== 'None' ? r : 'Common');

// One of a product's short extendedData fields (utils/tcgcsvSlim keeps them as
// `ext`), matched with case and punctuation ignored.
function extField(ext, name) {
  for (const [k, v] of Object.entries(ext || {})) {
    if (k.toLowerCase().replace(/[^a-z]/g, '') === name) return v;
  }
  return null;
}
const listOf = (v) => [...new Set(String(v || '').split(';').map(s => s.trim()).filter(s => s && s !== 'None'))];
const NO_STATS = new Set(['Legend', 'Battlefield', 'Rune']);
const statOf = (v) => (v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// What a card is, in the fields riftcodexApi.normalizeCard fills, from TCGplayer's:
//   Card Type 'Champion Unit' -> supertype Unit, subtypes Champion + the tags;
//   'Signature Gear' -> Gear + Signature; 'Unit;Token' -> Unit + Token;
//   'Rune' -> Rune + Basic, as RiftCodex files its runes.
// Domain 'Calm;Chaos' -> both, the colours; 'None' -> Colorless, as RiftCodex
// writes it. Legends, battlefields and runes carry no stats there (TCGplayer lists
// zeros), so none here. A row from a TCGCSV cache that predates `ext` has none of
// this until the next sync brings it.
function classify(ext) {
  if (!ext) return { supertype: '', subtypes: [], types: [], attributes: null, cmc: null, orientation: 'portrait' };
  let supertype = '';
  const kinds = [];
  for (const part of listOf(extField(ext, 'cardtype'))) {
    const m = /^(Champion|Signature)\s+(.+)$/.exec(part);
    if (m) {
      kinds.push(m[1]);
      supertype = supertype || m[2];
    } else if (part === 'Token') {
      kinds.push('Token');
    } else {
      supertype = supertype || part;
    }
  }
  if (supertype === 'Rune') kinds.push('Basic');
  const domains = listOf(extField(ext, 'domain'));
  const stats = {};
  if (!NO_STATS.has(supertype)) {
    for (const [key, field] of [['energy', 'energycost'], ['might', 'might'], ['power', 'powercost']]) {
      const n = statOf(extField(ext, field));
      if (n != null) stats[key] = n;
    }
  }
  return {
    supertype,
    subtypes: [...new Set([...kinds, ...listOf(extField(ext, 'tag'))])],
    types: domains.length ? domains : ['Colorless'],
    attributes: Object.keys(stats).length ? stats : null,
    cmc: stats.energy ?? null,
    orientation: supertype === 'Battlefield' ? 'landscape' : 'portrait',
  };
}

// One group's card rows, in the shape riftcodexApi.normalizeCard gives, with today's
// quote where TCGplayer has one (the daily sweep, riftboundPrices.js, keeps it
// current). `skip` is the products not to write.
function rowsFor(group, setId, code, products, quotes, skip) {
  const cards = products.filter(isCard);
  const ids = assignIds(code, cards);
  const rows = [];
  for (const p of cards) {
    if (skip.has(p.productId)) continue;
    const { id, number } = ids.get(p.productId);
    const q = quotes.get(p.productId);
    const trend = q ? (q.price_normal ?? q.price_holofoil) : null;
    const kind = classify(p.ext);
    rows.push({
      id,
      name: p.name || '',
      supertype: kind.supertype,
      subtypes: kind.subtypes,
      // Domains are Riftbound's colours (riftcodexApi.normalizeCard).
      types: kind.types,
      color_identity: kind.types,
      rarity: rarityOf(p.rarity),
      set_id: setId,
      set_name: group.name || '',
      number,
      // The slim cache leaves out TCGplayer's standard thumbnail url and keeps null
      // for a product with no picture (the CDN answers 403 then, not a placeholder).
      image_url: 'imageUrl' in p ? (p.imageUrl || '') : productImageUrl(p.productId),
      orientation: kind.orientation,
      artist: null,
      card_text: null,
      attributes: kind.attributes,
      cmc: kind.cmc,
      price_trend: trend,
      price_normal: q ? q.price_normal : null,
      price_holofoil: q ? q.price_holofoil : null,
      price_reverse_holofoil: null,
      price_avg1: null,
      price_avg7: null,
      price_avg30: null,
      price_currency: 'USD',
      // Null with no quote, so a stored TCGCSV price is kept (utils/cardCache).
      price_source: trend != null ? 'tcgcsv' : null,
      tcgplayer_product_id: p.productId,
      tcgplayer_url: `https://www.tcgplayer.com/product/${p.productId}`,
      game: GAME,
      language: 'English',
      printed_name: null,
    });
  }
  return rows;
}

// What decides whether a group's rows need writing again: everything but prices,
// which the daily sweep owns.
const PRICE_FIELDS = new Set(['price_trend', 'price_normal', 'price_holofoil', 'price_source']);
const rowsHash = (group, rows) => tcgcsvGames.hashOf([
  group.name, group.publishedOn,
  rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !PRICE_FIELDS.has(k)))),
]);

// --- state -------------------------------------------------------------------

// One tcgcsv_catalogues row: the stamp of the last write, and in product_hashes
//   groups     groupId -> { set, abbr, hash, ids }: what was written for each group
//   riftcodex  the set ids RiftCodex served cards in at its last refresh
//   epoch      counts RiftCodex's refreshes, so a write that began before one does
//              not stamp itself current after it
async function readState() {
  const row = await db.get(`SELECT catalogue_version, product_hashes FROM tcgcsv_catalogues WHERE game = ?`, [STATE_KEY]);
  let data = {};
  try { data = JSON.parse((row && row.product_hashes) || '{}') || {}; } catch { data = {}; }
  return {
    stamp: (row && row.catalogue_version) || null,
    groups: data.groups && typeof data.groups === 'object' ? data.groups : {},
    riftcodex: Array.isArray(data.riftcodex) ? data.riftcodex : null,
    epoch: Number(data.epoch) || 0,
  };
}

async function writeState(state) {
  await db.run(
    `INSERT INTO tcgcsv_catalogues (game, catalogue_version, product_hashes) VALUES (?, ?, ?)
     ON CONFLICT(game) DO UPDATE SET catalogue_version = excluded.catalogue_version,
       product_hashes = excluded.product_hashes`,
    [STATE_KEY, state.stamp, JSON.stringify({ groups: state.groups, riftcodex: state.riftcodex, epoch: state.epoch })]
  );
}

// The sets RiftCodex serves cards in. Recorded at each of its refreshes; until the
// first one after an upgrade, every Riftbound set in card_cache that this module did
// not write (it wrote none before). Null when RiftCodex's catalogue has never been
// cached: nothing can be written then, since anything might be RiftCodex's.
async function riftcodexSets(state) {
  if (state.riftcodex) return new Set(state.riftcodex);
  const mine = new Set(Object.values(state.groups).map(g => g.set));
  const rows = await db.all(
    `SELECT DISTINCT LOWER(set_id) AS sid FROM card_cache WHERE game = ? AND set_id IS NOT NULL AND set_id != ''`, [GAME]
  );
  const sets = rows.map(r => r.sid).filter(s => !mine.has(s));
  return sets.length ? new Set(sets) : null;
}

// The TCGplayer products RiftCodex serves already, in whichever of its sets.
async function riftcodexProducts(covered) {
  const rows = await db.all(
    `SELECT LOWER(set_id) AS sid, tcgplayer_product_id AS pid FROM card_cache
      WHERE game = ? AND tcgplayer_product_id IS NOT NULL`, [GAME]
  );
  return new Set(rows.filter(r => covered.has(r.sid)).map(r => Number(r.pid)));
}

// Of `ids`, those card_cache holds in a set other than `setId`. A set RiftCodex does
// not serve holds no card of RiftCodex's, so a row elsewhere on one of its ids is
// RiftCodex's (one of its cards carrying another set's code), and is never written
// over.
async function heldElsewhere(ids, setId) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = await db.all(
      `SELECT id FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')}) AND LOWER(COALESCE(set_id, '')) != ?`,
      [...chunk, setId]
    );
    for (const r of rows) out.add(r.id);
  }
  return out;
}

// A set's listing (setListing.js) names its card ids; it is a cache, read again from
// card_cache the next time the set is opened.
const forgetListing = (setId) =>
  db.run(`DELETE FROM set_listings WHERE game = ? AND LOWER(set_id) = LOWER(?)`, [GAME, setId]);

// A set row this module wrote (series 'TCGplayer'), never one of RiftCodex's: it
// writes rows for sets it lists before it has their cards.
const dropSetRow = (setId) =>
  db.run(`DELETE FROM sets WHERE id = ? AND game = ? AND series = 'TCGplayer'`, [setId, GAME]);

// --- writing -----------------------------------------------------------------
//
// No lock of this module's own: on a phone a request holds the database's turn
// (embedded/units.js), and one waiting here on a write a background job started,
// which needs that turn for its transactions, would wait for ever. Instead every
// write is a transaction that reads the state afresh, and RiftCodex's refresh
// records the sets it serves BEFORE it caches its cards (riftcodexApi
// .refreshCatalogue: noteRiftcodex, cacheCards, takeOver). So a group write either
// commits before that record, and RiftCodex's rows then land over it and takeOver
// takes it back, or finds the set RiftCodex's and writes nothing.

// Write the fallback rows from the TCGCSV cache. Only groups whose products changed
// are rewritten; returns { cards, removed, kept }, { unchanged: true }, or
// { missing: true } when the cache holds no category 89 to read.
async function materialize({ force = false } = {}) {
  const version = await tcgcsv.currentVersion();
  if (!version) return { missing: true };
  const start = await readState();
  const covered = await riftcodexSets(start);
  if (!covered) return { skipped: 'RiftCodex catalogue not cached' };
  const stamp = `${FORMAT}|${version}|${tcgcsvGames.hashOf([...covered].sort())}`;
  if (!force && start.stamp === stamp) return { unchanged: true };

  let groups;
  try {
    groups = await tcgcsv.getGroups(CATEGORY_ID);
  } catch (e) {
    if (tcgcsv.isCacheMissError(e)) return { missing: true };
    throw e;
  }
  // No groups at all is a day without data, not a category TCGplayer emptied.
  if (!groups.length) return { missing: true };
  // Codes over every group of the category, so a group's set id never moves when
  // another group comes or goes.
  const codes = tcgcsvGames.setCodes(groups);
  const served = await riftcodexProducts(covered);
  const tables = await referencingTables();
  let cards = 0;
  const dropped = { removed: 0, kept: 0 };

  // One group's rows and its state entry, in one transaction. `rows` null takes the
  // group back whole (TCGplayer dropped it). Ids written before and not now — a
  // product TCGplayer removed or renumbered, one RiftCodex now serves — go, except
  // held ones.
  const writeGroup = (gid, setId, group, rows, hash) => db.withTransaction(async () => {
    const now = await readState();
    // RiftCodex took the set over since this run began.
    if ((await riftcodexSets(now) || new Set()).has(setId)) return;
    const before = now.groups[gid];
    if (!force && rows && before && before.hash === hash && before.set === setId) return;   // written meanwhile
    const written = new Set((rows || []).map(r => r.id));
    const gone = before ? before.ids.filter(id => !written.has(id)) : [];
    if (rows && rows.length) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, 'TCGplayer', ?, ?, ?, ?, '', '', ?)`,
        // ptcgo_code is the set's code everywhere a set is picked (riftcodexApi.listSetCodes,
        // the catalog build picker), so it is the assigned code.
        [setId, group.name || setId, rows.length, rows.length, String(group.publishedOn || '').slice(0, 10),
          setId.slice(SET_PREFIX.length).toUpperCase(), GAME]
      );
      // keepPrices: a product with no quote today keeps the price it had.
      await cacheNormalizedCards(rows, GAME, { keepPrices: true });
      cards += rows.length;
    }
    const r = await deleteUnreferenced(gone, tables);
    dropped.removed += r.removed.length;
    dropped.kept += r.kept.length;
    if (!(rows && rows.length) && !r.kept.length) await dropSetRow(setId);
    await forgetListing(setId);
    if (rows && rows.length) now.groups[gid] = { set: setId, abbr: group.abbreviation || null, hash, ids: [...written] };
    else delete now.groups[gid];
    await writeState(now);
  });

  for (const g of groups) {
    const code = codes.get(g.groupId);
    const setId = `${SET_PREFIX}${code}`;
    if (covered.has(setId)) continue;   // RiftCodex's
    const before = start.groups[g.groupId];
    let products;
    try {
      products = await tcgcsv.getProducts(CATEGORY_ID, g.groupId);
    } catch (e) {
      if (!tcgcsv.isCacheMissError(e)) throw e;
      products = [];
    }
    // No product list today: a day TCGCSV had nothing for the group (the mirror keeps
    // `[]` for a 404), which says nothing about its cards. What was written stays.
    if (!products.length) continue;
    let prices = [];
    try { prices = await tcgcsv.getPrices(CATEGORY_ID, g.groupId); } catch (e) { if (!tcgcsv.isCacheMissError(e)) throw e; }
    const candidates = rowsFor(g, setId, code, products, quotesByProduct(prices), served);
    const foreign = await heldElsewhere(candidates.map(r => r.id), setId);
    const rows = candidates.filter(r => !foreign.has(r.id));
    // Sealed product only (a bundle, a set not out yet), or every card RiftCodex's.
    if (!rows.length && !before) continue;
    const hash = rowsHash(g, rows);
    if (!force && before && before.hash === hash && before.set === setId) continue;
    await writeGroup(String(g.groupId), setId, g, rows, hash);
  }

  // Groups written before that TCGplayer lists no more. (One whose set is RiftCodex's
  // now is takeOver's, which knows which ids are RiftCodex's.)
  const listed = new Set(groups.map(g => String(g.groupId)));
  for (const [gid, before] of Object.entries(start.groups)) {
    if (listed.has(gid) || covered.has(before.set)) continue;
    await writeGroup(gid, before.set, {}, null, null);
  }

  // Current — unless RiftCodex refreshed meanwhile, and the next read weighs it all again.
  await db.withTransaction(async () => {
    const now = await readState();
    if (now.epoch !== start.epoch) return;
    now.stamp = stamp;
    await writeState(now);
  });
  if (cards || dropped.removed || dropped.kept) {
    try { await require('./utils/compartmentSort').loadSetsCache(db); } catch { /* the weekly refresh reloads it */ }
    console.log(`Riftbound: ${cards} card(s) of sets RiftCodex lacks written from TCGplayer`
      + (dropped.removed ? `, ${dropped.removed} no longer listed removed` : '')
      + (dropped.kept ? `, ${dropped.kept} kept because a collection, deck, list, recipe or trade refers to them` : '') + '.');
  }
  return { cards, ...dropped };
}

const setsOf = (cards) => new Set((cards || []).map(c => String(c.set_id || '').toLowerCase()).filter(Boolean));

// RiftCodex is about to cache `cards`, its whole catalogue (riftcodexApi
// .refreshCatalogue). Record the sets it serves first: from here on no write of
// this module lands in one of them.
async function noteRiftcodex(cards) {
  const covered = setsOf(cards);
  if (!covered.size) return;
  await db.withTransaction(async () => {
    const now = await readState();
    now.riftcodex = [...covered].sort();
    // Weigh every group again on the next read: which products RiftCodex serves
    // may have changed with the sets.
    now.stamp = null;
    now.epoch += 1;
    await writeState(now);
  });
}

// RiftCodex has cached `cards`. Each set this module wrote that RiftCodex serves now
// is RiftCodex's: its rows are on the ids the two share, and the rest go, except a
// card something refers to. Returns { removed, kept }.
async function takeOver(cards) {
  const covered = setsOf(cards);
  const theirs = new Set((cards || []).map(c => c.id));
  const tables = await referencingTables();
  let removed = 0, kept = 0;
  for (const [gid, entry] of Object.entries((await readState()).groups)) {
    if (!covered.has(entry.set)) continue;
    await db.withTransaction(async () => {
      const now = await readState();
      const current = now.groups[gid];
      if (!current || current.set !== entry.set) return;
      const r = await deleteUnreferenced(current.ids.filter(id => !theirs.has(id)), tables);
      removed += r.removed.length;
      kept += r.kept.length;
      await forgetListing(current.set);
      delete now.groups[gid];
      await writeState(now);
    });
    console.log(`Riftbound: RiftCodex serves ${entry.set} now, and its cards are RiftCodex's.`);
  }
  if (removed || kept) {
    console.log(`Riftbound: ${removed} TCGplayer-only card(s) RiftCodex does not list removed`
      + (kept ? `; ${kept} kept because a collection, deck, list, recipe or trade refers to them` : '') + '.');
  }
  return { removed, kept };
}

// --- on an install -------------------------------------------------------------

// Not shared between callers: on a phone, a request waiting on a write a background
// job started would wait for ever (above). Two at once only repeat each other's
// work, and each group write sees what the other wrote.
const writeFromCache = () => materialize();

// At most this often, a missing category 89 starts a sync to fill it in.
const SYNC_RETRY_MS = 60 * 60 * 1000;
let syncTriedAt = 0;

// Bring the fallback rows up to date from the TCGCSV cache, and wait for that: local
// work, and two reads once current. Every Riftbound read calls it (riftcodexApi).
//
// When TCGCSV data is cached but category 89 is not in it — an install that has
// priced only Pokémon so far — it fills the category in with the same sync a
// TCGplayer-catalogue game's first use runs (tcgcsvGameApi.runFirstUseSync, which a
// phone lifts its TCGCSV switch for), at most hourly, and waits for that only with
// `waitForSync`: a search is not held up by a download. With no TCGCSV data at all,
// the scheduled sync brings category 89 (tcgcsvApi.demandedCategories), as it does
// for Riftbound prices, and the next read writes the rows. `sync: false` never syncs.
async function ensure({ sync = true, waitForSync = false } = {}) {
  const result = await writeFromCache();
  if (!result.missing || !sync) return result;
  if (!(await tcgcsv.currentVersion())) return result;
  if (Date.now() - syncTriedAt < SYNC_RETRY_MS) return result;
  syncTriedAt = Date.now();
  // Work this read starts and may not wait for (utils/backgroundWork): on a phone a
  // background job of its own, which a read that does wait for it waits on with its
  // turn let go — the sync and the writes need that turn.
  const work = require('./utils/backgroundWork');
  const filled = work.start('Riftbound sets RiftCodex lacks', async () => {
    await tcgcsvGames.runFirstUseSync('Riftbound sets RiftCodex lacks');
    return writeFromCache();
  }).catch((e) => {
    console.warn(`Riftbound TCGplayer fallback: ${e.message}`);
    return result;
  });
  return waitForSync ? work.join(filled) : result;
}

// TCGplayer's own abbreviation for a set this module wrote ('RXK/DA' where the set's
// code is 'rxkda'), for TCGplayer's Mass Entry; null for any other set.
async function tcgplayerAbbreviation(setId) {
  const sid = String(setId || '').toLowerCase();
  const state = await readState();
  const hit = Object.values(state.groups).find(g => g.set === sid);
  return (hit && hit.abbr) || null;
}

module.exports = {
  codeTail, looseNumber, assignIds, classify, rowsFor,
  materialize, noteRiftcodex, takeOver, ensure, tcgplayerAbbreviation,
  STATE_KEY,
};
