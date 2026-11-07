// The one place that knows card_cache's column list.
//
// Every provider (pokemontcg.io, Scryfall, TCGdex) had its own copy of this
// INSERT, so adding a column meant finding all of them — and the third provider
// would have made a fourth copy. They all produce the same normalized card shape
// before writing, so they all write through here instead.
const db = require('../db');

const COLUMNS = [
  'id', 'name', 'supertype', 'subtypes', 'types', 'rarity', 'set_id', 'set_name',
  'number', 'image_url', 'image_url_back', 'price_trend', 'price_normal', 'price_holofoil',
  'price_reverse_holofoil', 'price_avg1', 'price_avg7', 'price_avg30', 'cmc',
  'color_identity', 'game', 'language', 'printed_name',
  'tcgplayer_url', 'cardmarket_url', 'tcgplayer_product_id',
  'price_currency', 'price_source', 'oracle_id', 'oracle_text',
];

// A page of results can be 250 cards and one round trip per card cost more than
// the provider fetch did, so rows go in batched — chunked small enough that the
// bound-parameter count stays well inside SQLite's limit.
const CHUNK = 50;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Upsert, not INSERT OR REPLACE. REPLACE deletes the row and inserts a new one, so
// every column this list does NOT name is silently reset to its default — which
// already cost price_1st_edition (written by tcgcsvApi, never by a provider) on every
// re-cache, and would cost the English name learned below the same way.
const SET_CLAUSE = COLUMNS
  .filter(c => c !== 'id' && c !== 'name')
  .map(c => `${c} = excluded.${c}`)
  .join(', ');

// `name` is the one column an incoming row can be WORSE at. A non-English TCGdex
// card carries its localized name in both `name` and `printed_name` because TCGdex
// has no English name to give (see tcgdexApi.normalizeCard) — but one may since have
// been learned from the card's English printing (cardApi.learnEnglishName), and that
// is what makes a Japanese card findable by typing its English name. Keep it: an
// incoming name that IS just the printed name is not new information.
const NAME_CLAUSE = `name = CASE
    WHEN excluded.name = excluded.printed_name AND card_cache.name <> card_cache.printed_name
    THEN card_cache.name ELSE excluded.name END`;

// Upsert already-normalized cards. `game` is passed rather than read off the card
// so a provider can never write rows under the wrong game by forgetting a field.
//
// `opts.incomplete` marks rows written from a partial source — a TCGdex set brief
// carries only id/name/number/image, no rarity, types or prices. Such a row is
// stamped as already-stale so every freshness check in the app treats it as
// needing a refetch, instead of it looking current forever and showing a real
// card with $0.00 and the wrong rarity.
async function cacheNormalizedCards(cards, game, opts = {}) {
  const stamp = opts.incomplete ? `'1970-01-01 00:00:00'` : 'CURRENT_TIMESTAMP';
  const rowSql = `(${COLUMNS.map(() => '?').join(', ')}, ${stamp})`;
  const rows = (cards || []).filter(c => c && c.id);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    for (const c of chunk) {
      params.push(
        c.id, c.name || '', c.supertype || '',
        JSON.stringify(c.subtypes || []), JSON.stringify(c.types || []),
        c.rarity || 'Common', c.set_id || '', c.set_name || '', c.number || '',
        // Only double-faced Magic cards have a back; null for every other row.
        c.image_url || '', c.image_url_back || null, num(c.price_trend), num(c.price_normal),
        num(c.price_holofoil), num(c.price_reverse_holofoil), num(c.price_avg1),
        num(c.price_avg7), num(c.price_avg30), num(c.cmc),
        JSON.stringify(c.color_identity || []), game,
        c.language || 'English', c.printed_name || null,
        c.tcgplayer_url || null, c.cardmarket_url || null,
        num(c.tcgplayer_product_id),
        c.price_currency || 'USD', c.price_source || null,
        // Magic only (scryfallApi.normalizeCard); the deck rules read both. Text is
        // '' for a card read and found blank, null for one never read.
        c.oracle_id || null, c.oracle_text ?? null,
      );
    }
    await db.run(
      `INSERT INTO card_cache (${COLUMNS.join(', ')}, last_updated)
       VALUES ${chunk.map(() => rowSql).join(', ')}
       ON CONFLICT(id) DO UPDATE SET ${NAME_CLAUSE}, ${SET_CLAUSE}, last_updated = ${stamp}`,
      params
    );
  }
}

module.exports = { cacheNormalizedCards, CARD_CACHE_COLUMNS: COLUMNS };
