const express = require('express');
const db = require('../db');
const { resolveCardPrice, parseCardRow } = require('../utils/priceHelpers');
const { compartmentLabel } = require('../utils/compartmentSort');

const router = express.Router();

// One container, laid out the way its owner sees it: its pages or rows, and the
// slot each card sits in — so a shared binder reads as a binder and a shared box
// as a box, instead of collapsing to a flat card list.
//
// Gated on share_locations, not just share_enabled: where a card is stored is
// exactly what this exposes, and that is the setting the owner opts into.
router.get('/:share_token/containers/:id', async (req, res) => {
  const { share_token, id } = req.params;
  try {
    const owner = await db.get(`SELECT id, username, share_enabled, share_locations FROM users WHERE share_token = ?`, [share_token]);
    if (!owner || owner.share_enabled === 0) {
      return res.status(404).json({ error: 'This card collection is private or does not exist.' });
    }
    if (owner.share_locations !== 1) {
      return res.status(404).json({ error: 'This collection does not share where its cards are stored.' });
    }

    const location = await db.get(
      `SELECT id, name, type, sort_order, allow_stacking FROM locations WHERE id = ? AND user_id = ?`,
      [id, owner.id]
    );
    if (!location) return res.status(404).json({ error: 'Container not found.' });

    const compartments = await db.all(
      `SELECT id, idx, label, capacity FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
      [location.id]
    );

    // Same public column set as the collection share above — no purchase price,
    // no ROI — plus the placement columns the layout is drawn from.
    const rows = await db.all(`
      SELECT c.id AS entry_id, c.card_id, c.compartment_id, c.position, c.quantity, c.condition,
             c.printing, c.language, c.favorite, c.is_trade, c.market_value,
             cc.name, cc.printed_name, cc.supertype, cc.subtypes, cc.types, cc.rarity,
             cc.set_id, cc.set_name, cc.number, cc.image_url, cc.game, cc.cmc, cc.color_identity,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.price_1st_edition
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.location_id = ? AND c.user_id = ? AND c.list_type = 'collection'
      ORDER BY c.position ASC, c.id ASC
    `, [location.id, owner.id]);

    const cards = rows.map(row => ({ ...parseCardRow(row), price_trend: resolveCardPrice(row) }));

    res.json({
      owner: owner.username,
      location,
      compartments: compartments.map(c => ({ ...c, display_label: compartmentLabel(c, location.type) })),
      cards
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve shared container' });
  }
});

// Retrieve a shared collection by share token
router.get('/:share_token', async (req, res) => {
  const { share_token } = req.params;
  const listType = req.query.list || 'collection';

  try {
    const owner = await db.get(`SELECT id, username, share_enabled, share_locations FROM users WHERE share_token = ?`, [share_token]);
    if (!owner || owner.share_enabled === 0) {
      return res.status(404).json({ error: 'This card collection is private or does not exist.' });
    }

    let filterSql = `WHERE c.user_id = ?`;
    let filterParams = [owner.id];

    if (listType === 'wishlist') {
      filterSql += ` AND c.list_type = 'wishlist'`;
    } else if (listType === 'trade') {
      filterSql += ` AND c.is_trade = 1 AND c.list_type = 'collection'`;
    } else {
      filterSql += ` AND c.list_type = 'collection'`;
    }

    // Retrieve their collection without private fields (locations, purchase price, ROI)
    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        -- The owner's own valuation for this copy (a graded slab, usually), which
        -- resolveCardPrice prefers. Without it a shared collection prices every
        -- slab as if it were raw, and its total disagrees with the owner's.
        c.market_value,
        cc.name,
        -- The name as printed on a non-English card, so a shared Japanese
        -- collection reads the way the cards actually look.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        l.name AS location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const shareLocations = owner.share_locations === 1;
    const formatted = rows.map(row => {
      const card = {
        ...parseCardRow(row),
        price_trend: resolveCardPrice(row),
      };
      // Card locations are private by default; only expose when the owner has
      // opted in, and strip the raw column otherwise.
      delete card.location_name;
      if (shareLocations) card.location = row.location_name || 'Unsorted';
      return card;
    });

    // Calculate public stats
    let totalCards = 0;
    let uniqueCards = formatted.length;
    let totalValue = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};

    formatted.forEach(row => {
      const qty = row.quantity || 1;
      const price = row.price_trend || 0;

      totalCards += qty;
      totalValue += qty * price;

      row.types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (row.types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
      }

      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: row.set_name, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += qty * price;
    });

    res.json({
      owner: owner.username,
      shareLocations,
      collection: formatted,
      stats: {
        summary: {
          totalCards,
          uniqueCards,
          totalValue: parseFloat(totalValue.toFixed(2))
        },
        types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
        rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
        sets: Object.keys(setCounts).map(id => ({
          id,
          name: setCounts[id].name,
          count: setCounts[id].count,
          value: parseFloat(setCounts[id].value.toFixed(2))
        })).sort((a, b) => b.value - a.value).slice(0, 8)
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve shared collection' });
  }
});

module.exports = router;
