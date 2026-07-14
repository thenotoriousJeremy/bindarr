const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { resolveCardPrice, isVintageSet, parseSqliteUtc } = require('../utils/priceHelpers');

const router = express.Router();
router.use(authenticateToken);

// 7. Get Collection Statistics & Analytics
router.get('/stats', async (req, res) => {
  try {
    // Optional per-game view (e.g. only Pokémon or only MTG). Absent = all games.
    const { game } = req.query;
    const gameFilter = game ? ` AND cc.game = ?` : '';
    const statsParams = game ? [req.user.id, game] : [req.user.id];

    // Retrieve all collection items to compute statistics
    const query = `
      SELECT
        c.quantity, c.purchase_price, c.added_at, c.printing, c.condition, c.card_id,
        cc.types, cc.rarity, cc.set_name, cc.set_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil,
        cc.price_avg1, cc.price_avg7, cc.price_avg30,
        l.name as location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      WHERE c.user_id = ?${gameFilter}
    `;
    const rows = await db.all(query, statsParams);

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

      totalCards += qty;
      totalValue += qty * price;
      totalSpent += qty * (row.purchase_price || 0);
      if (!row.location_name) unsortedCount += qty;

      if (row.condition === 'Near Mint') {
        nearMintCount += qty;
      }

      if (isVintageSet(row.set_id)) {
        vintageCount += qty;
      }

      // Only count a card toward the historical comparison if it was owned
      // that long ago AND has real Cardmarket data for both ends of the
      // window. Comparing avg7/avg30 against price_trend (usually TCGPlayer)
      // would mix two different marketplaces' pricing and produce a "change"
      // that's really just the static US/EU price gap, not real movement —
      // avg1 keeps both sides of the comparison on Cardmarket.
      if (addedTime <= now - sevenDaysMs && row.price_avg7 > 0 && row.price_avg1 > 0) {
        value7dAgo += qty * row.price_avg7;
        valueNowFor7d += qty * row.price_avg1;
      }
      if (addedTime <= now - thirtyDaysMs && row.price_avg30 > 0 && row.price_avg1 > 0) {
        value30dAgo += qty * row.price_avg30;
        valueNowFor30d += qty * row.price_avg1;
      }

      // Parse types
      const types = JSON.parse(row.types || '[]');
      types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
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
      setCounts[row.set_id].value += qty * price;

      // Location
      const loc = row.location_name || 'Unassigned';
      locationCounts[loc] = (locationCounts[loc] || 0) + qty;
    });

    // Get top most valuable cards (scoped to user)
    const topValuableQuery = `
      SELECT
        c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
        (SELECT type FROM locations WHERE id = c.location_id) AS location_type,
        c.quantity, c.condition, c.printing, c.language, c.purchase_price,
        cc.id as card_id, cc.name, cc.rarity, cc.set_name, cc.image_url, cc.price_trend,
        cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?${gameFilter}
      ORDER BY CASE
        WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
        WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
        WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
        ELSE cc.price_trend
      END DESC
      LIMIT 6
    `;
    const topValuableRows = await db.all(topValuableQuery, statsParams);
    const topValuable = topValuableRows.map(row => ({
      ...row,
      price_trend: resolveCardPrice(row)
    }));

    // Compute progress for top 4 sets in database (estimate set total)
    const setSizes = {
      'base1': 102,  // Base Set
      'base2': 64,   // Jungle
      'base3': 62,   // Fossil
      'base4': 130,  // Base Set 2
      'neo1': 111,   // Neo Genesis
      'cel25': 25,   // Celebrations
      'swsh1': 202,  // Sword & Shield Base
      'swsh11': 196, // Lost Origin
      'swsh12': 98,  // Silver Tempest
      'sv1': 198,    // Scarlet & Violet Base
      'sv2': 193,    // Paldea Evolved
      'sv3': 197,    // Obsidian Flames
      'sv3pt5': 165, // 151
    };

    const setProgress = [];
    for (const setId in setCounts) {
      const userUniqueInSet = await db.get(`
        SELECT COUNT(DISTINCT card_id) as count
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE cc.set_id = ? AND c.user_id = ?
      `, [setId, req.user.id]);

      const size = setSizes[setId] || 150; // default estimate if set not in database
      const count = userUniqueInSet.count;
      setProgress.push({
        setId,
        setName: setCounts[setId].name,
        ownedUnique: count,
        totalCards: size,
        percent: Math.min(Math.round((count / size) * 100), 100)
      });
    }

    // Sort set progress by completion percentage descending
    setProgress.sort((a, b) => b.percent - a.percent);

    const mintRate = totalCards > 0 ? parseFloat(((nearMintCount / totalCards) * 100).toFixed(1)) : 0.0;
    const vintageRatio = totalCards > 0 ? parseFloat(((vintageCount / totalCards) * 100).toFixed(1)) : 0.0;

    // Recently added cards (most useful "what did I just add" glance)
    const recentRows = await db.all(`
      SELECT c.id AS entry_id, c.location_id, (SELECT name FROM locations WHERE id = c.location_id) AS location_name,
             (SELECT type FROM locations WHERE id = c.location_id) AS location_type,
             c.quantity, c.condition, c.printing, c.language, c.added_at,
             cc.id as card_id, cc.name, cc.rarity, cc.set_name, cc.number, cc.image_url,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?${gameFilter}
      ORDER BY c.added_at DESC
      LIMIT 6
    `, statsParams);
    const recentAdditions = recentRows.map(row => ({ ...row, price_trend: resolveCardPrice(row) }));

    const gainAbs = totalValue - totalSpent;
    const roi = {
      abs: parseFloat(gainAbs.toFixed(2)),
      pct: totalSpent > 0 ? parseFloat(((gainAbs / totalSpent) * 100).toFixed(1)) : null
    };
    const avgCardValue = totalCards > 0 ? parseFloat((totalValue / totalCards).toFixed(2)) : 0.0;

    res.json({
      summary: {
        totalCards,
        uniqueCards,
        totalValue: parseFloat(totalValue.toFixed(2)),
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
          abs: parseFloat((valueNowFor7d - value7dAgo).toFixed(2)),
          pct: parseFloat((((valueNowFor7d - value7dAgo) / value7dAgo) * 100).toFixed(1))
        } : { available: false, abs: null, pct: null },
        change30d: value30dAgo > 0 ? {
          available: true,
          abs: parseFloat((valueNowFor30d - value30dAgo).toFixed(2)),
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
        value: parseFloat(setCounts[id].value.toFixed(2))
      })).sort((a, b) => b.value - a.value).slice(0, 8),
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
    const { period = '30d' } = req.query;

    // Retrieve all collection items to compute history
    const query = `
      SELECT c.quantity, c.added_at, c.printing, cc.id as card_id, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `;
    const items = await db.all(query, [req.user.id]);

    // Real recorded price snapshots for every card this user owns, oldest
    // first, so each item's price at any past point can be looked up without
    // per-item queries. No source anywhere provides price history beyond
    // what this table accumulates over the app's actual real lifetime.
    const cardIds = [...new Set(items.map(i => i.card_id))];
    let historyByCard = {};
    if (cardIds.length > 0) {
      const placeholders = cardIds.map(() => '?').join(',');
      const historyRows = await db.all(
        `SELECT card_id, price, recorded_at FROM price_history WHERE card_id IN (${placeholders}) ORDER BY recorded_at ASC`,
        cardIds
      );
      historyRows.forEach(r => {
        if (!historyByCard[r.card_id]) historyByCard[r.card_id] = [];
        historyByCard[r.card_id].push({ price: r.price, time: parseSqliteUtc(r.recorded_at).getTime() });
      });
    }

    // Real price for a card at a point in time: the latest recorded snapshot
    // at or before that time; if history only starts later, carry the
    // earliest real snapshot backward rather than guess; if the card has no
    // history at all, fall back to its current real price_trend. Every value
    // used here was actually recorded or is the actual current price — never
    // a fabricated curve.
    const realPriceAt = (item, targetTime) => {
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
          totalValue += item.quantity * realPriceAt(item, targetTime);
        }
      });

      historyData.push({
        date: formatLabel(targetDate),
        value: parseFloat(totalValue.toFixed(2))
      });
    }

    res.json(historyData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute timeline history' });
  }
});

// Supported chart windows. Maps a range key to its length in days; anything
// unrecognized (e.g. 'all') returns the full recorded history.
const PRICE_HISTORY_RANGES = { '1m': 30, '1y': 365, '5y': 1825 };

// Get Card Price History
router.get('/cards/:id/price-history', async (req, res) => {
  const { id } = req.params;
  const rangeKey = String(req.query.range || '1y').toLowerCase();
  const days = PRICE_HISTORY_RANGES[rangeKey]; // undefined => 'all'
  try {
    let history = days
      ? await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ? AND recorded_at >= datetime('now', ?)
          ORDER BY recorded_at ASC
        `, [id, `-${days} days`])
      : await db.all(`
          SELECT price, recorded_at
          FROM price_history
          WHERE card_id = ?
          ORDER BY recorded_at ASC
        `, [id]);

    history = history.map(h => ({ price: h.price, recorded_at: h.recorded_at }));
    const realCount = history.length;

    // Fill in with real anchor points instead of fabricating a curve: the
    // current price, plus Cardmarket's real avg7/avg30. Only meaningful on
    // the 1-month window — on a 1y/5y timeline, a point 7 or 30 days back
    // sits right on top of "now" and previously got added for every range
    // (the `days >= 7`/`days >= 30` guards were always true for all three
    // defined ranges), which is why every window looked the same.
    const cacheCard = await db.get(`SELECT price_trend, price_avg1, price_avg7, price_avg30 FROM card_cache WHERE id = ?`, [id]);
    if (cacheCard) {
      const now = Date.now();
      const nowPrice = cacheCard.price_avg1 > 0 ? cacheCard.price_avg1 : cacheCard.price_trend;
      const anchors = [{ price: nowPrice, time: now }];
      if (rangeKey === '1m') {
        if (cacheCard.price_avg30 > 0) anchors.push({ price: cacheCard.price_avg30, time: now - 30 * 86400000 });
        if (cacheCard.price_avg7 > 0) anchors.push({ price: cacheCard.price_avg7, time: now - 7 * 86400000 });
      }
      for (const a of anchors) {
        if (a.price > 0) {
          history.push({ price: a.price, recorded_at: new Date(a.time).toISOString() });
        }
      }
    }

    history.sort((a, b) => parseSqliteUtc(a.recorded_at) - parseSqliteUtc(b.recorded_at));

    // 1y/5y have no real historical price source beyond this app's own
    // weekly-cadence price_history table (see Dashboard's change1y/5y, which
    // is marked unavailable rather than faked for the same reason) — flag it
    // instead of rendering a near-identical current-price-only line.
    const insufficientHistory = (rangeKey === '1y' || rangeKey === '5y') && realCount < 2;

    res.json({ data: history, insufficientHistory });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve price history' });
  }
});

module.exports = router;
