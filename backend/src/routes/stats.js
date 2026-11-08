const express = require('express');
const db = require('../db');
const { resolveCardPrice, isVintageSet, parseSqliteUtc } = require('../utils/priceHelpers');
const { convert, pickUnit, roundMoney, parseCurrencyParam } = require('../utils/fx');
const fxRates = require('../fxRates');

const games = require('../utils/games');

// A ?game= the registry does not know matched no rows and read as an empty
// collection; say it is wrong instead.
const badGame = (game) => !!game && !games.isGame(game);

const router = express.Router();

const rowCurrency = (row) => row.price_currency || 'USD';

// Cardmarket's rolling averages are quoted in euros. The one provider that can
// fill those columns from TCGplayer instead says so in price_source.
const avgCurrency = (row) => (row.price_source === 'pokemontcgapi-tcgplayer' ? 'USD' : 'EUR');

// Which currency this response's money is reported in (review item 9).
//
// Prices are stored as each marketplace quoted them (Scryfall and TCGplayer in
// USD, Cardmarket and TCGdex in EUR), and the totals here used to add them up as
// they stood, so one $10 card and one 10 EUR card were "worth 20" of nothing in
// particular. Now every amount is converted to `?currency=` (the owner's display
// currency, default USD) through the ECB rates first. Without rates, a
// collection quoted in one currency is reported in that currency, and a mixed
// one has no single total at all: `unit` is null, and the per-currency subtotals
// are the only honest answer.
async function reportingUnit(rows, requested) {
  const target = parseCurrencyParam(requested) || 'USD';
  const fx = await fxRates.latestRates();
  const currencies = new Set(rows.filter(r => resolveCardPrice(r) > 0).map(rowCurrency));
  const unit = pickUnit(currencies, target, fx);
  // A zero is zero in every currency, so it never needs a rate.
  const toUnit = (amount, from) => (!amount ? 0 : (unit ? convert(amount, from, unit, fx) : null));
  const converted = unit != null && [...currencies].some(c => c !== unit);
  return { target, fx, unit, currencies, toUnit, converted, fxDate: converted ? fx.date : null };
}

const roundByCurrency = (byCurrency) => Object.fromEntries(
  Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b)).map(([c, v]) => [c, roundMoney(v, c)])
);

// 7. Get Collection Statistics & Analytics
router.get('/stats', async (req, res) => {
  try {
    // Optional per-game view (e.g. only Pokémon or only MTG). Absent = all games.
    const { game } = req.query;
    if (badGame(game)) return res.status(400).json({ error: 'Invalid game' });
    const gameFilter = game ? ` AND cc.game = ?` : '';
    const statsParams = game ? [req.user.id, game] : [req.user.id];

    // Retrieve all collection items to compute statistics
    const query = `
      SELECT
        c.quantity, c.purchase_price, c.added_at, c.printing, c.condition, c.card_id, c.market_value,
        cc.types, cc.subtypes, cc.supertype, cc.game, cc.rarity, cc.set_name, cc.set_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition,
        cc.price_avg1, cc.price_avg7, cc.price_avg30, cc.price_currency, cc.price_source,
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?${gameFilter}
    `;
    const rows = await db.all(query, statsParams);
    const money = await reportingUnit(rows, req.query.currency);
    const { unit, toUnit } = money;
    const valueByCurrency = {};

    let totalCards = 0;
    let uniqueCards = rows.length;
    let totalValue = 0;
    let totalSpent = 0;
    let unsortedCount = 0;
    let nearMintCount = 0;
    let vintageCount = 0;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;
    const thirtyDaysMs = 30 * oneDayMs;

    // Cardmarket's avg7/avg30 are the only genuine historical price data this
    // app can get (nothing goes back further than 30 days from any source).
    // Both the "now" and "then" totals below are summed over the SAME subset
    // of cards that actually have that real data, so the percentage change
    // isn't skewed by cards silently missing from one side of the comparison.
    let value7dAgo = 0, valueNowFor7d = 0;
    let value30dAgo = 0, valueNowFor30d = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};
    const locationCounts = {};

    rows.forEach(row => {
      const qty = row.quantity || 1;
      const price = resolveCardPrice(row);
      const addedTime = row.added_at ? parseSqliteUtc(row.added_at).getTime() : now;
      const cur = rowCurrency(row);
      // In `unit`, or 0 for a row that cannot be, which only happens when unit
      // is null, and then nothing summed in unit is reported.
      const value = toUnit(qty * price, cur) || 0;

      totalCards += qty;
      if (price > 0) valueByCurrency[cur] = (valueByCurrency[cur] || 0) + qty * price;
      totalValue += value;
      totalSpent += qty * (row.purchase_price || 0);
      if (!row.location_name) unsortedCount += qty;

      if (row.condition === 'Near Mint') {
        nearMintCount += qty;
      }

      // Pokémon set ids only: 'ex', 'si' and 'base' prefixes mean nothing to Magic.
      if (row.game === 'pokemon' && isVintageSet(row.set_id)) {
        vintageCount += qty;
      }

      // Only count a card toward the historical comparison if it was owned
      // that long ago AND has real Cardmarket data for both ends of the
      // window. Comparing avg7/avg30 against price_trend (usually TCGPlayer)
      // would mix two different marketplaces' pricing and produce a "change"
      // that's really just the static US/EU price gap, not real movement —
      // avg1 keeps both sides of the comparison on Cardmarket.
      //
      // Converted like everything else: averages from both marketplaces can sit
      // in one collection. A row whose average cannot be converted drops out of
      // both ends, which keeps the subset the same on each side.
      const avgCur = avgCurrency(row);
      const then7 = toUnit(qty * row.price_avg7, avgCur), then30 = toUnit(qty * row.price_avg30, avgCur);
      const nowAvg = toUnit(qty * row.price_avg1, avgCur);
      if (addedTime <= now - sevenDaysMs && row.price_avg7 > 0 && row.price_avg1 > 0 && then7 != null && nowAvg != null) {
        value7dAgo += then7;
        valueNowFor7d += nowAvg;
      }
      if (addedTime <= now - thirtyDaysMs && row.price_avg30 > 0 && row.price_avg1 > 0 && then30 != null && nowAvg != null) {
        value30dAgo += then30;
        valueNowFor30d += nowAvg;
      }

      // Parse types
      const types = JSON.parse(row.types || '[]');
      const subtypes = JSON.parse(row.subtypes || '[]');
      const isMtg = row.game === 'mtg' || row.supertype === 'MTG';

      if (isMtg) {
        const isLand = subtypes.includes('Land') || row.supertype === 'Land' || (types.length === 0 && subtypes.some(s => ['Plains','Island','Swamp','Mountain','Forest','Land'].includes(s)));
        if (isLand) {
          typeCounts['Land'] = (typeCounts['Land'] || 0) + qty;
        } else if (types.length === 0) {
          typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
        } else {
          types.forEach(t => {
            typeCounts[t] = (typeCounts[t] || 0) + qty;
          });
        }
      } else {
        types.forEach(t => {
          typeCounts[t] = (typeCounts[t] || 0) + qty;
        });
        if (types.length === 0) {
          typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
        }
      }

      // Rarity
      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      // Set
      const set = row.set_name || 'Other';
      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: set, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += value;

      // Location
      const loc = row.location_name || 'Unassigned';
      locationCounts[loc] = (locationCounts[loc] || 0) + qty;
    });

    // Get top most valuable cards (scoped to user). Ranked in `unit`, so a 40 EUR
    // card is compared with a $45 one at the day's rate rather than as 40 vs 45.
    const rankFactor = { sql: '1', params: [] };
    if (unit && money.converted) {
      const whens = [...money.currencies].map(c => {
        rankFactor.params.push(c, convert(1, c, unit, money.fx));
        return 'WHEN ? THEN ?';
      });
      rankFactor.sql = `(CASE COALESCE(cc.price_currency, 'USD') ${whens.join(' ')} ELSE 1 END)`;
    }
    const topValuableQuery = `
      SELECT
        c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
        (SELECT type FROM locations WHERE id = c.location_id) AS location_type,
        c.quantity, c.condition, c.printing, c.language, c.purchase_price, c.is_trade, c.favorite, c.list_type,
        c.grader, c.grade, c.market_value,
        cc.id as card_id, cc.name, cc.printed_name, cc.rarity, cc.set_name, cc.set_id, cc.number, cc.image_url, cc.image_url_back,
        cc.game, cc.supertype, cc.subtypes, cc.types, cc.cmc, cc.color_identity, cc.price_trend,
        cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition, cc.price_currency
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?${gameFilter}
      ORDER BY CASE
        -- Mirrors resolveCardPrice, market_value first. A PSA 10 valued at 40x its
        -- raw price has to be able to reach this list, and ranking it by the raw
        -- price is exactly how it never would.
        WHEN c.market_value IS NOT NULL AND c.market_value > 0 THEN c.market_value
        WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
        WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
        WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
        WHEN c.printing = '1st Edition' AND cc.price_1st_edition IS NOT NULL AND cc.price_1st_edition > 0 THEN cc.price_1st_edition
        ELSE cc.price_trend
      END * ${rankFactor.sql} DESC
      LIMIT 6
    `;
    const topValuableRows = await db.all(topValuableQuery, [...statsParams, ...rankFactor.params]);
    const topValuable = topValuableRows.map(row => ({
      ...row,
      price_trend: resolveCardPrice(row)
    }));

    // Set completion.
    //
    // Sizes come from the `sets` table, which every provider sync fills in — not
    // from a hand-kept map. That map listed thirteen Pokémon ids and fell back to a
    // flat 150 for everything else, so every Magic set and every Pokémon set
    // released after 151 was measured against a number nobody chose. printed_total
    // is the right column (the number printed on the card, which is what a player
    // counts to); `total` includes secret rares and is the fallback when a provider
    // gives no printed count.
    //
    // One query for the whole thing, rather than one per set inside a loop: this
    // ran a COUNT(DISTINCT) per set the user owns cards from, which on a broad
    // collection is dozens of round trips to answer a single panel.
    //
    // Magic is the one game whose two tables spell a set differently: card_cache
    // holds Scryfall's bare code ("mh3", scryfallApi.normalizeCard) and `sets` the
    // prefixed id ("mtg-mh3", fetchAndCacheSets), so this lookup never matched and
    // no Magic set ever appeared here. Every other reader of both forms (the sets
    // route, catalog's new-set count, compartmentSort.fixedSetKey, the scanner and
    // search set pickers) already converts, so the id is mapped here rather than
    // re-keying either table.
    //
    // Owned counts collector numbers, not card ids: each language of a Magic
    // printing is its own card_cache row, and #12 in English and in Japanese is
    // still one card of the set.
    const setIds = Object.keys(setCounts);
    const setProgress = [];
    if (setIds.length) {
      const holes = setIds.map(() => '?').join(',');
      const rows = await db.all(`
        SELECT cc.game, cc.set_id,
               COUNT(DISTINCT COALESCE(NULLIF(cc.number, ''), cc.id)) AS owned,
               (SELECT COALESCE(NULLIF(s.printed_total, 0), NULLIF(s.total, 0))
                  FROM sets s
                 WHERE s.id = CASE WHEN cc.game = 'mtg' THEN 'mtg-' || LOWER(cc.set_id) ELSE cc.set_id END) AS size
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.user_id = ?${gameFilter} AND cc.set_id IN (${holes})
        GROUP BY cc.game, cc.set_id
      `, [...statsParams, ...setIds]);

      for (const row of rows) {
        // A set the sync has not reached yet has no size, so it has no completion
        // to report. Skipped rather than given a placeholder denominator: "3 / 150"
        // for a set that actually holds 64 cards is a wrong answer presented as a
        // measurement, which is what the old flat-150 fallback did.
        if (!row.size) continue;
        setProgress.push({
          setId: row.set_id,
          setName: setCounts[row.set_id].name,
          ownedUnique: row.owned,
          totalCards: row.size,
          percent: Math.min(Math.round((row.owned / row.size) * 100), 100)
        });
      }
    }

    // Sort set progress by completion percentage descending
    setProgress.sort((a, b) => b.percent - a.percent);

    const mintRate = totalCards > 0 ? parseFloat(((nearMintCount / totalCards) * 100).toFixed(1)) : 0.0;
    const vintageRatio = totalCards > 0 ? parseFloat(((vintageCount / totalCards) * 100).toFixed(1)) : 0.0;

    // Recently added cards (most useful "what did I just add" glance)
    const recentRows = await db.all(`
      SELECT c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
             (SELECT type FROM locations WHERE id = c.location_id) AS location_type,
             c.quantity, c.condition, c.printing, c.language, c.added_at, c.is_trade, c.favorite, c.list_type,
             c.grader, c.grade, c.market_value,
             cc.id as card_id, cc.name, cc.printed_name, cc.rarity, cc.set_name, cc.set_id, cc.number, cc.image_url, cc.image_url_back,
             cc.game, cc.supertype, cc.subtypes, cc.types, cc.cmc, cc.color_identity,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition, cc.price_currency
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?${gameFilter}
      ORDER BY c.added_at DESC
      LIMIT 6
    `, statsParams);
    const recentAdditions = recentRows.map(row => ({ ...row, price_trend: resolveCardPrice(row) }));

    // Purchase prices carry no currency: they are whatever the owner typed, in
    // the currency their display was set to. So a gain is only computed when the
    // value is reported in that same currency.
    const gainAbs = totalValue - totalSpent;
    const roi = unit === money.target ? {
      abs: roundMoney(gainAbs, unit),
      pct: totalSpent > 0 ? parseFloat(((gainAbs / totalSpent) * 100).toFixed(1)) : null
    } : { abs: null, pct: null };
    const avgCardValue = !unit ? null : totalCards > 0 ? roundMoney(totalValue / totalCards, unit) : 0.0;

    res.json({
      summary: {
        totalCards,
        uniqueCards,
        // Null when the collection mixes currencies and no rate is known to
        // convert them; valueByCurrency always has the subtotals as quoted.
        totalValue: unit ? roundMoney(totalValue, unit) : null,
        valueCurrency: unit,
        valueByCurrency: roundByCurrency(valueByCurrency),
        converted: money.converted,
        fxDate: money.fxDate,
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        roi,
        avgCardValue,
        unsortedCount,
        duplicateCopies: Math.max(totalCards - uniqueCards, 0),
        mintRate,
        vintageRatio,
        // change7d/change30d compare current vs. real Cardmarket avg7/avg30
        // over the same subset of cards that have that data — never
        // simulated. change1y/change5y have no real data source anywhere
        // (no API here provides pricing history beyond 30 days), so they're
        // marked unavailable instead of faked.
        change7d: value7dAgo > 0 ? {
          available: true,
          abs: roundMoney(valueNowFor7d - value7dAgo, unit),
          pct: parseFloat((((valueNowFor7d - value7dAgo) / value7dAgo) * 100).toFixed(1))
        } : { available: false, abs: null, pct: null },
        change30d: value30dAgo > 0 ? {
          available: true,
          abs: roundMoney(valueNowFor30d - value30dAgo, unit),
          pct: parseFloat((((valueNowFor30d - value30dAgo) / value30dAgo) * 100).toFixed(1))
        } : { available: false, abs: null, pct: null },
        change1y: { available: false, abs: null, pct: null },
        change5y: { available: false, abs: null, pct: null }
      },
      types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
      rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
      sets: Object.keys(setCounts).map(id => ({
        id,
        name: setCounts[id].name,
        count: setCounts[id].count,
        value: unit ? roundMoney(setCounts[id].value, unit) : null
      })).sort((a, b) => (b.value || 0) - (a.value || 0) || b.count - a.count).slice(0, 8),
      locations: Object.keys(locationCounts).map(name => ({ name, value: locationCounts[name] })),
      topValuable,
      recentAdditions,
      setProgress: setProgress.slice(0, 4)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute statistics' });
  }
});

// 7b. Get Collection Net Worth Timeline History
router.get('/stats/history', async (req, res) => {
  try {
    const { period = '30d', game } = req.query;
    if (badGame(game)) return res.status(400).json({ error: 'Invalid game' });
    const gameFilter = game ? ` AND cc.game = ?` : '';
    const params = game ? [req.user.id, game] : [req.user.id];

    // Retrieve all collection items to compute history
    const query = `
      SELECT c.quantity, c.added_at, c.printing, c.market_value, cc.id as card_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition,
             cc.price_currency
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?${gameFilter}
    `;
    const items = await db.all(query, params);
    // Same unit as /stats reports for the same rows, so the chart and the total
    // above it agree. Each item's history is in its card's current currency (the
    // filter below), so one conversion per point covers it.
    const { unit, toUnit } = await reportingUnit(items, req.query.currency);

    // Real recorded price snapshots for every card this user owns, oldest
    // first, so each item's price at any past point can be looked up without
    // per-item queries. No source anywhere provides price history beyond
    // what this table accumulates over the app's actual real lifetime.
    //
    // "Every card this user owns" is a subquery on the collection, the same
    // rows and game filter as the query above, not a list of ids. That list
    // bound one variable per distinct card, and past SQLite's 32,766 a large
    // collection's whole timeline was a 500.
    //
    // Only points in the card's current currency. After a currency switch (the
    // admin's MTG price source, #93) the old points are a different unit, and
    // mixing them in would draw the switch as a price move. Dropping them makes
    // the card's earliest point in the new currency carry backward instead —
    // the same rule realPriceAt already applies to any card with short history.
    const historyByCard = {};
    const historyRows = await db.all(
      `SELECT ph.card_id, ph.price, ph.recorded_at FROM price_history ph
         JOIN card_cache cc ON cc.id = ph.card_id
        WHERE ph.card_id IN (SELECT card_id FROM collection WHERE user_id = ?)${gameFilter}
          AND (ph.currency IS NULL OR ph.currency = COALESCE(cc.price_currency, 'USD'))
        ORDER BY ph.recorded_at ASC`,
      params
    );
    historyRows.forEach(r => {
      if (!historyByCard[r.card_id]) historyByCard[r.card_id] = [];
      historyByCard[r.card_id].push({ price: r.price, time: parseSqliteUtc(r.recorded_at).getTime() });
    });

    // Real price for a card at a point in time: the latest recorded snapshot
    // at or before that time; if history only starts later, carry the
    // earliest real snapshot backward rather than guess; if the card has no
    // history at all, fall back to its current real price_trend. Every value
    // used here was actually recorded or is the actual current price — never
    // a fabricated curve.
    const realPriceAt = (item, targetTime) => {
      // price_history tracks the PRINTING, so for a copy with its own value (a
      // slab) it is the wrong series entirely — a PSA 10 does not follow the raw
      // card down. There is no per-copy history to draw instead, so it holds flat
      // at the value on record rather than reporting the raw card's movement.
      if (item.market_value > 0) return item.market_value;
      const hist = historyByCard[item.card_id];
      if (!hist || hist.length === 0) return resolveCardPrice(item);
      let best = null;
      for (const h of hist) {
        if (h.time <= targetTime) best = h;
        else break;
      }
      return (best || hist[0]).price;
    };

    const now = Date.now();
    let step = 0;
    let count = 0;
    let formatLabel = (d) => d.toLocaleDateString();

    if (period === '7d') {
      count = 7;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { weekday: 'short' });
    } else if (period === '30d') {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else if (period === '1y') {
      count = 12;
      step = 30 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    } else if (period === '5y') {
      count = 20;
      step = 91 * 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } else {
      count = 30;
      step = 24 * 60 * 60 * 1000;
      formatLabel = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    const historyData = [];
    for (let i = count - 1; i >= 0; i--) {
      const targetTime = now - (i * step);
      const targetDate = new Date(targetTime);

      let totalValue = 0;
      items.forEach(item => {
        const addedTime = parseSqliteUtc(item.added_at).getTime();
        if (addedTime <= targetTime) {
          totalValue += toUnit(item.quantity * realPriceAt(item, targetTime), rowCurrency(item)) || 0;
        }
      });

      historyData.push({
        date: formatLabel(targetDate),
        // Null for a mixed collection with no rates: no single line is honest.
        value: unit ? roundMoney(totalValue, unit) : null
      });
    }

    res.json(historyData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute timeline history' });
  }
});

// 7c. Net worth, on its own, for scripts and dashboards (issue #33).
//
// /stats already contains these numbers, but it also runs the type/rarity/set
// aggregation, a per-set progress query and two top-N queries to get there —
// which is the wrong thing to hand a finance tracker polling every five minutes.
// This is one pass over the collection and nothing else.
//
// Pair it with an API key (Settings -> API access): that credential is read-only
// and does not expire, so an external tracker keeps working without a login.
router.get('/stats/networth', async (req, res) => {
  try {
    const { game } = req.query;
    if (badGame(game)) return res.status(400).json({ error: 'Invalid game' });
    const gameFilter = game ? ` AND cc.game = ?` : '';
    const params = game ? [req.user.id, game] : [req.user.id];

    const rows = await db.all(`
      SELECT c.quantity, c.purchase_price, c.printing, c.market_value, cc.game, cc.price_currency,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ? AND c.list_type = 'collection'${gameFilter}
    `, params);

    const money = await reportingUnit(rows, req.query.currency);
    const { unit, toUnit } = money;
    let totalCards = 0, totalValue = 0, totalSpent = 0;
    const byGame = {};
    const valueByCurrency = {};
    for (const row of rows) {
      const qty = row.quantity || 1;
      const quoted = qty * resolveCardPrice(row);
      const cur = rowCurrency(row);
      const value = toUnit(quoted, cur) || 0;
      totalCards += qty;
      totalValue += value;
      totalSpent += qty * (row.purchase_price || 0);
      if (quoted > 0) valueByCurrency[cur] = (valueByCurrency[cur] || 0) + quoted;
      const g = row.game || 'unknown';
      if (!byGame[g]) byGame[g] = { cards: 0, value: 0 };
      byGame[g].cards += qty;
      byGame[g].value += value;
    }

    const round = (n) => parseFloat(n.toFixed(2));
    const gain = unit === money.target ? totalValue - totalSpent : null;
    res.json({
      // In `currency`: ?currency= (default USD) when the ECB rates cover every
      // currency present, else the one currency the collection is quoted in, else
      // null with only valueByCurrency to go on. It used to sum USD and EUR as
      // they stood.
      totalValue: unit ? roundMoney(totalValue, unit) : null,
      currency: unit,
      valueByCurrency: roundByCurrency(valueByCurrency),
      converted: money.converted,
      fxDate: money.fxDate,
      totalSpent: round(totalSpent),
      // The unrealized gain, which is the number a finance tracker actually wants
      // next to the total: value minus what it cost. Null percentage rather than
      // zero when nothing has a purchase price, because "0% return" is a claim.
      // Purchase prices have no currency of their own, so a gain is only offered
      // when the value is in the currency that was asked for.
      gain: gain == null ? null : round(gain),
      gainPct: gain != null && totalSpent > 0 ? parseFloat(((gain / totalSpent) * 100).toFixed(1)) : null,
      totalCards,
      uniqueEntries: rows.length,
      byGame: Object.fromEntries(Object.entries(byGame).map(([g, v]) => [g, { cards: v.cards, value: unit ? roundMoney(v.value, unit) : null }])),
      // Every currency the prices were quoted in, before conversion.
      currencies: [...money.currencies].sort(),
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute net worth' });
  }
});

// Two windows, because two is all anyone can actually fill:
//   30d — Cardmarket publishes real rolling averages (avg30/avg7/avg1) that give
//         a genuine month of trend for free, per request, with no storage.
//   all — everything Bindarr has recorded itself.
// 1y/5y are gone. No card API sells back-history: Scryfall returns only current
// prices (usd/eur/tix, no historical field at all), so a 5-year MTG chart could
// never be anything but the same line as the 30-day one.
const PRICE_HISTORY_RANGES = { '30d': 30 };

// Cardmarket's rolling averages, as real dated points. avg30 is the mean of the
// last 30 days, so it is plotted at the middle of that span, not its start —
// plotting a 30-day MEAN at "30 days ago" would misread as the price on that
// day. Same for avg7. avg1 is yesterday's average.
function marketAnchors(card, now) {
  const pts = [];
  if (!card) return pts;
  if (card.price_avg30 > 0) pts.push({ price: card.price_avg30, time: now - 15 * 86400000, source: 'market' });
  if (card.price_avg7 > 0) pts.push({ price: card.price_avg7, time: now - 3.5 * 86400000, source: 'market' });
  if (card.price_avg1 > 0) pts.push({ price: card.price_avg1, time: now - 86400000, source: 'market' });
  if (card.price_trend > 0) pts.push({ price: card.price_trend, time: now, source: 'current' });
  return pts;
}

// Get Card Price History
router.get('/cards/:id/price-history', async (req, res) => {
  const { id } = req.params;
  const rangeKey = String(req.query.range || '30d').toLowerCase();
  const days = PRICE_HISTORY_RANGES[rangeKey]; // undefined => 'all'
  try {
    // Points in the card's current currency only — see the same filter in the
    // timeline above. A card with no card_cache row keeps every point.
    const sameCurrency = `(currency IS NULL OR currency = COALESCE(
      (SELECT price_currency FROM card_cache WHERE id = price_history.card_id), currency))`;
    const recorded = days
      ? await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ? AND recorded_at >= datetime('now', ?) AND ${sameCurrency}
          ORDER BY recorded_at ASC
        `, [id, `-${days} days`])
      : await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ? AND ${sameCurrency}
          ORDER BY recorded_at ASC
        `, [id]);

    const now = Date.now();
    const points = recorded.map(h => ({
      price: h.price,
      time: parseSqliteUtc(h.recorded_at).getTime(),
      source: 'recorded'
    }));
    const recordedCount = points.length;

    // Market averages only describe the last 30 days, so they belong on the
    // 30-day window; on 'all' they would crowd the left edge of a longer line.
    const anchors = rangeKey === '30d'
      ? marketAnchors(await db.get(
        `SELECT price_trend, price_avg1, price_avg7, price_avg30 FROM card_cache WHERE id = ?`, [id]
      ), now)
      : [];
    const marketCount = anchors.filter(a => a.source === 'market').length;
    points.push(...anchors);

    points.sort((a, b) => a.time - b.time);

    // Collapse flat runs. The sweep used to write a row on every boot whether or
    // not the price moved, so cards carry hundreds of identical snapshots. Only
    // the ENDS of a flat stretch carry information — the interior points draw
    // the same horizontal line. Keeping both ends preserves its true duration.
    const data = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[i - 1];
      const next = points[i + 1];
      if (prev && next && prev.price === points[i].price && next.price === points[i].price) continue;
      data.push(points[i]);
    }

    const times = points.map(p => p.time);
    const spanDays = times.length >= 2
      ? Math.round((Math.max(...times) - Math.min(...times)) / 86400000)
      : 0;

    res.json({
      data: data.map(p => ({ price: p.price, recorded_at: new Date(p.time).toISOString(), source: p.source })),
      // What the line is actually made of, so the UI can say so rather than
      // implying Bindarr knows more than it does.
      marketCount,
      recordedCount,
      insufficientHistory: data.length < 2,
      spanDays,
      windowDays: days ?? null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve price history' });
  }
});

module.exports = router;
