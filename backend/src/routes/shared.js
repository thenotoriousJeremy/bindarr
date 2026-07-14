const express = require('express');
const db = require('../db');
const { resolveCardPrice, parseCardRow } = require('../utils/priceHelpers');

const router = express.Router();

// Retrieve a shared collection by share token
router.get('/:share_token', async (req, res) => {
  const { share_token } = req.params;
  const listType = req.query.list || 'collection';

  try {
    const owner = await db.get(`SELECT id, username, share_enabled FROM users WHERE share_token = ?`, [share_token]);
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
        c.list_type,
        cc.name,
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
        cc.price_reverse_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
    }));

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
