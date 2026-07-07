import sys

with open('backend/src/routes/collection.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """// Distributes every owned set across a location's compartments automatically,
// sizing each set to however many compartments it actually needs
// (ceil(ownedCount / capacity)). Biggest sets are placed first so they get
// first pick of consecutive compartments; anything that doesn't fit is
// reported back instead of silently dropped.
router.post('/locations/:id/auto-assign-sets', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const compartments = await db.all(`SELECT id, idx, capacity FROM compartments WHERE location_id = ? ORDER BY idx ASC`, [id]);
    if (compartments.length === 0) return res.status(400).json({ error: 'This location has no compartments' });

    const setCounts = await db.all(`
      SELECT cc.set_name, SUM(c.quantity) as owned
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ? AND cc.set_name IS NOT NULL
      GROUP BY cc.set_name
    `, [req.user.id]);

    const setsBySize = setCounts
      .map(s => ({ setName: s.set_name, compartmentsNeeded: Math.max(1, Math.ceil(s.owned / (compartments[0]?.capacity || 40))) }))
      .sort((a, b) => b.compartmentsNeeded - a.compartmentsNeeded);

    const plan = new Map(); // compartment id -> [set names]
    let cursor = 0;
    const skipped = [];
    for (const { setName, compartmentsNeeded } of setsBySize) {
      if (cursor + compartmentsNeeded > compartments.length) {
        skipped.push(setName);
        continue;
      }
      for (let i = 0; i < compartmentsNeeded; i++) {
        const compartment = compartments[cursor + i];
        if (!plan.has(compartment.id)) plan.set(compartment.id, []);
        plan.get(compartment.id).push(setName);
      }
      cursor += compartmentsNeeded;
    }

    for (const compartment of compartments) {
      await db.run(`DELETE FROM compartment_set_assignments WHERE compartment_id = ?`, [compartment.id]);
      for (const setName of plan.get(compartment.id) || []) {
        await db.run(`INSERT OR IGNORE INTO compartment_set_assignments (compartment_id, set_name) VALUES (?, ?)`, [compartment.id, setName]);
      }
    }

    res.json({
      message: 'Row assignments updated',
      assigned: Array.from(plan.entries()).map(([compartment_id, sets]) => ({ compartment_id, sets })),
      skipped
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to auto-assign sets' });
  }
});"""

replacement = """// Distributes every owned category (based on the location's sort_order)
// across a location's compartments automatically, sizing each category to
// however many compartments it actually needs.
router.post('/locations/:id/auto-assign-categories', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id, sort_order FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const compartments = await db.all(`SELECT id, idx, capacity FROM compartments WHERE location_id = ? ORDER BY idx ASC`, [id]);
    if (compartments.length === 0) return res.status(400).json({ error: 'This location has no compartments' });

    const allCards = await db.all(`
      SELECT c.quantity, cc.name, cc.set_name, cc.number, cc.types, cc.price_trend
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `, [req.user.id]);

    const { loadSetsCache, sortCards } = require('../utils/compartmentSort');
    await loadSetsCache(db);
    // Since getSortCategory is not exported, we need to export it, but wait! We can just fetch it from utils/compartmentSort.js!
    const { getSortCategory } = require('../utils/compartmentSort');

    const catCounts = new Map();
    allCards.forEach(c => {
      try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; }
      const cat = getSortCategory(c, loc.sort_order);
      if (cat) {
        catCounts.set(cat, (catCounts.get(cat) || 0) + c.quantity);
      }
    });

    const catsBySize = Array.from(catCounts.entries())
      .map(([catName, owned]) => ({ catName, compartmentsNeeded: Math.max(1, Math.ceil(owned / (compartments[0]?.capacity || 40))) }))
      .sort((a, b) => b.compartmentsNeeded - a.compartmentsNeeded);

    const plan = new Map();
    let cursor = 0;
    const skipped = [];
    for (const { catName, compartmentsNeeded } of catsBySize) {
      if (cursor + compartmentsNeeded > compartments.length) {
        skipped.push(catName);
        continue;
      }
      for (let i = 0; i < compartmentsNeeded; i++) {
        const compartment = compartments[cursor + i];
        if (!plan.has(compartment.id)) plan.set(compartment.id, []);
        plan.get(compartment.id).push(catName);
      }
      cursor += compartmentsNeeded;
    }

    for (const compartment of compartments) {
      await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [compartment.id]);
      for (const catName of plan.get(compartment.id) || []) {
        await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [compartment.id, catName]);
      }
    }

    res.json({
      message: 'Row assignments updated',
      assigned: Array.from(plan.entries()).map(([compartment_id, filters]) => ({ compartment_id, filters })),
      skipped
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to auto-assign categories' });
  }
});"""

if target in content:
    content = content.replace(target, replacement)
    print("Updated auto-assign route in collection.js")
else:
    print("Target auto-assign not found in collection.js")

with open('backend/src/routes/collection.js', 'w', encoding='utf-8') as f:
    f.write(content)
