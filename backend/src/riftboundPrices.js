// TCGplayer prices for Riftbound, from TCGCSV category 89.
//
// RiftCodex has no prices, but every card it lists names its TCGplayer product
// (`tcgplayer_id`, kept as card_cache.tcgplayer_product_id), so the join here is
// by that product id and nothing else: no set matching, no number matching, no
// names. That is not caution for its own sake. Riftbound printings share numbers
// with products worth very different amounts — an OPP promo and its Metal
// printing carry one collector number and differ about a hundredfold — and a
// number key would price one off the other with a straight face. A card with no
// product, or whose product TCGCSV does not quote, is left exactly as it is.
//
// The data comes through tcgcsvApi's daily sync and its cache, never a request of
// this module's own: category 89 rides the same pacing, the same 403 cooldown and
// the same TCGCSV_BASE_URL as the Pokémon categories (tcgcsvApi
// OPTIONAL_SYNC_CATEGORIES). Every group in the category is read, so a new set
// prices with no mapping to maintain — RiftCodex's own set-to-group ids are
// incomplete (Vendetta has none) and one of them names the wrong group.
//
// Finishes are 'Normal' and 'Foil' here, not Pokémon's Holofoil family. Foil goes
// in price_holofoil, the column every two-finish game reads for a 'Holofoil'
// (labelled Foil) copy. Most Unleashed singles are listed Foil only, so
// price_trend prefers the Normal quote and falls back to the Foil one.
const db = require('./db');
const tcgcsv = require('./tcgcsvApi');
const { recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');

const CATEGORY_ID = 89;
const GAME = 'riftbound';
// The same source the Pokémon TCGCSV sweep writes: TCGplayer market prices in USD,
// for the printing itself (Riftbound is English-only, so there is no proxy case).
const SOURCE = 'tcgcsv';
const FINISH_COLUMN = { Normal: 'price_normal', Foil: 'price_holofoil' };

// TCGplayer's market price (from actual sales), else the listing midpoint, else
// nothing. Never zero: a zero would read as a price.
const priceOf = (row) => (row.marketPrice > 0 ? row.marketPrice : (row.midPrice > 0 ? row.midPrice : null));

// One group's price rows -> productId -> { price_normal, price_holofoil }.
function quotesByProduct(rows, into = new Map()) {
  for (const r of rows || []) {
    const col = FINISH_COLUMN[r && r.subTypeName];
    const price = col ? priceOf(r) : null;
    if (price == null) continue;
    const id = Number(r.productId);
    if (!Number.isFinite(id)) continue;
    const q = into.get(id) || { price_normal: null, price_holofoil: null };
    if (q[col] == null) q[col] = price;
    into.set(id, q);
  }
  return into;
}

async function updateCollectionPrices(force = false) {
  try {
    const listed = await db.get(
      `SELECT COUNT(*) AS n FROM card_cache WHERE game = ? AND tcgplayer_product_id IS NOT NULL`, [GAME]
    );
    // An install that has never cached a Riftbound card has nothing to price, and
    // the sync does not fetch category 89 for it either.
    if (!listed || !listed.n) return { priced: 0, skipped: 'no Riftbound cards' };

    // A failed or paused sync (network, 5xx, the 403 cooldown) leaves the last
    // complete version in the cache, and yesterday's prices beat none.
    await tcgcsv.syncIfUpdatedSafely('Riftbound price update');
    if (!force && !(await shouldSweepPrices(GAME))) {
      return { priced: 0, skipped: 'swept recently' };
    }

    let groups;
    try {
      groups = await tcgcsv.getGroups(CATEGORY_ID);
    } catch (err) {
      if (tcgcsv.isCacheMissError(err)) {
        // Not marked swept: the next tick tries again once a sync has landed.
        console.warn(`Skipping Riftbound price update: TCGCSV category ${CATEGORY_ID} is not cached yet.`);
        return { priced: 0, skipped: 'not cached' };
      }
      throw err;
    }

    const quotes = new Map();
    for (const group of groups) {
      try {
        quotesByProduct(await tcgcsv.getPrices(CATEGORY_ID, group.groupId), quotes);
      } catch (err) {
        if (!tcgcsv.isCacheMissError(err)) throw err;
        console.warn(`Riftbound prices: group ${group.groupId} is not cached; its cards keep their prices.`);
      }
    }

    // Every listed card, not only owned ones: the requests are per group either
    // way, and a card being browsed is worth a price too. History is recorded for
    // owned and decked cards only — it is what the trend charts are for, and a
    // point per catalogue card per day would be most of price_history.
    const cards = await db.all(
      `SELECT id, tcgplayer_product_id FROM card_cache WHERE game = ? AND tcgplayer_product_id IS NOT NULL`, [GAME]
    );
    const tracked = new Set((await db.all(
      `SELECT card_id FROM collection WHERE game = ? UNION SELECT dc.card_id FROM deck_cards dc
        JOIN card_cache cc ON cc.id = dc.card_id WHERE cc.game = ?`, [GAME, GAME]
    )).map(r => r.card_id));

    let priced = 0;
    let unquoted = 0;
    for (const card of cards) {
      const q = quotes.get(Number(card.tcgplayer_product_id));
      // No quote today leaves the stored price alone. Writing null would erase a
      // real price over a gap in one day's data; writing 0 would invent one.
      if (!q) { unquoted++; continue; }
      const trend = q.price_normal ?? q.price_holofoil;
      // Today's quote for this product is the whole answer for its finishes, the
      // same rule as tcgcsvApi.priceSet: a finish it no longer quotes is cleared.
      await db.run(
        `UPDATE card_cache
            SET price_trend = ?, price_normal = ?, price_holofoil = ?,
                price_source = ?, price_currency = 'USD'
          WHERE id = ?`,
        [trend, q.price_normal, q.price_holofoil, SOURCE, card.id]
      );
      if (tracked.has(card.id)) await recordPrice(card.id, trend);
      priced++;
    }
    await markPricesSwept(GAME);
    console.log(`Riftbound price update complete: ${priced} cards priced, ${unquoted} with no TCGplayer quote.`);
    return { priced, unquoted };
  } catch (err) {
    console.error('Error during Riftbound price update:', err.message);
    return { priced: 0, error: err.message };
  }
}

module.exports = { CATEGORY_ID, FINISH_COLUMN, quotesByProduct, updateCollectionPrices };
