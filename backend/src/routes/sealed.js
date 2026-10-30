const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const tcgcsv = require('../tcgcsvApi');
const { productCardCount } = require('../utils/sealedContents');
const { allocateSealedUnitCost } = require('../utils/sealedCostAllocation');

const router = express.Router();

// A product's contents the user already matches by product identity: by
// product_id when the purchase is catalog-linked, else an exact product_name
// match. Returns the template plus its components, or null.
async function matchTemplate(userId, productId, productName) {
  const template = productId
    ? await db.get(`SELECT * FROM sealed_templates WHERE user_id = ? AND product_id = ?`, [userId, productId])
    : await db.get(`SELECT * FROM sealed_templates WHERE user_id = ? AND product_id IS NULL AND product_name = ?`, [userId, productName]);
  if (!template) return null;
  const components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
  return { ...template, components };
}

// Create every component a template defines for one unit: card components go
// straight into the collection, linked to that unit; product components become
// brand-new sealed purchases (their own units, not priced individually — cost
// basis stays on the parent) that can be opened and linked later like any other
// sealed product. Idempotent via sealed_units.components_applied_at.
async function applyTemplateComponents(unit, purchase, template, { includeCards = true } = {}) {
  const { addCardToCollection } = require('./collection');
  const productComponentsByKey = new Map();
  for (const component of template.components) {
    if (component.component_type !== 'product') continue;
    const game = component.game || purchase.game;
    const identity = component.product_id
      ? `id:${component.product_id}`
      : `name:${String(component.product_name || '').trim()}`;
    const key = `${game}:${identity}`;
    const existing = productComponentsByKey.get(key);
    if (existing) existing.quantity += Math.max(1, component.quantity || 1);
    else productComponentsByKey.set(key, { ...component, game, quantity: Math.max(1, component.quantity || 1) });
  }
  const productComponents = [...productComponentsByKey.values()];
  for (const component of productComponents) {
    component.cardCount = await productCardCount(
      purchase.user_id, component.product_id, component.product_name, component.expected_cards);
  }
  const productCards = productComponents.reduce((sum, component) =>
    sum + component.quantity * component.cardCount, 0);
  const cardUnitCount = template.components.reduce((sum, component) =>
    sum + (component.component_type === 'card' && component.card_id ? Math.max(1, component.quantity || 1) : 0), 0);
  const componentUnitCount = cardUnitCount + productCards;
  const componentUnitPrice = purchase.unit_price == null || componentUnitCount === 0
    ? null
    : Number(purchase.unit_price) / componentUnitCount;
  const applied = [];

  for (const c of template.components) {
    if (c.component_type === 'card') {
      if (!includeCards || !c.card_id) continue;
      await addCardToCollection({ id: purchase.user_id }, {
        card_id: c.card_id, quantity: c.quantity || 1, game: c.game || purchase.game,
        sealed_unit_id: unit.id, purchase_price: componentUnitPrice,
      });
      applied.push(c);
    }
  }

  for (const c of productComponents) {
      let name = c.product_name, setName = null, type = c.sealed_type, image = null;
      if (c.product_id) {
        const catalogRow = await db.get(
          `SELECT name, group_name, sealed_type, image_url FROM tcgplayer_catalog WHERE product_id = ?`,
          [c.product_id]
        );
        if (catalogRow) {
          name = name || catalogRow.name;
          setName = catalogRow.group_name;
          type = type || catalogRow.sealed_type;
          image = catalogRow.image_url;
        }
      }
      const existingRows = c.product_id
        ? await db.all(
          `SELECT id, quantity, unit_price FROM sealed_purchases
            WHERE user_id = ? AND source_unit_id = ? AND game = ? AND product_id = ?`,
          [purchase.user_id, unit.id, c.game, c.product_id]
        )
        : await db.all(
          `SELECT id, quantity, unit_price FROM sealed_purchases
            WHERE user_id = ? AND source_unit_id = ? AND game = ? AND product_id IS NULL AND product_name = ?`,
          [purchase.user_id, unit.id, c.game, name || c.product_name]
        );
      for (const row of existingRows) {
        if (row.unit_price == null && componentUnitPrice != null) {
          const productUnitPrice = componentUnitPrice * c.cardCount;
          await db.run(`UPDATE sealed_purchases SET unit_price = ? WHERE id = ?`, [productUnitPrice, row.id]);
        }
      }
      const existingQuantity = existingRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
      const qty = Math.max(0, c.quantity - existingQuantity);
      if (qty === 0) continue;
      const result = await db.run(
        `INSERT INTO sealed_purchases
           (user_id, product_id, product_name, set_name, sealed_type, game, image_url, store, purchase_date, unit_price, quantity, expected_cards, source_unit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [purchase.user_id, c.product_id || null, name || c.product_name, setName, type, c.game || purchase.game,
          image, `Unboxed from: ${purchase.product_name}`, unit.opened_at,
          componentUnitPrice == null ? null : componentUnitPrice * c.cardCount, qty,
          c.expected_cards == null || c.expected_cards === '' ? null : Number(c.expected_cards), unit.id]
      );
      for (let i = 0; i < qty; i++) {
        await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [result.lastID]);
      }
      applied.push({ ...c, quantity: qty });
  }
  await db.run(`UPDATE sealed_units SET components_applied_at = COALESCE(components_applied_at, CURRENT_TIMESTAMP) WHERE id = ?`, [unit.id]);
  return applied;
}

// Search the TCGplayer/TCGCSV sealed-product catalog for the "pick from catalog"
// UI. Sealed rows are the ones tcgplayerCatalog.js writes with number IS NULL;
// carded rows are excluded here on purpose.
router.get('/sealed/catalog/search', async (req, res) => {
  const { q = '', game = '', type = '' } = req.query;
  const query = String(q || '').trim();
  if (!query) return res.json({ products: [] });
  const where = [`number IS NULL`, `name LIKE ?`];
  const params = [`%${query}%`];
  if (game) { where.push(`game = ?`); params.push(String(game)); }
  if (type) { where.push(`sealed_type = ?`); params.push(String(type)); }
  try {
    const products = await db.all(
      `SELECT product_id, name, group_name, set_id, game, image_url, sealed_type
         FROM tcgplayer_catalog
        WHERE ${where.join(' AND ')}
        ORDER BY name ASC
        LIMIT 25`,
      params
    );
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search sealed catalog', message: error.message });
  }
});

// One row per purchase, with how many of its units are still sealed vs opened.
router.get('/sealed/purchases', async (req, res) => {
  try {
    const purchases = await db.all(
      `SELECT p.*,
              source_purchase.product_name AS source_product_name,
              (SELECT COUNT(*) FROM sealed_units earlier_unit
                WHERE earlier_unit.purchase_id = source_purchase.id AND earlier_unit.id <= source_unit.id) AS source_unit_number,
              COUNT(u.id) AS unit_count,
              SUM(CASE WHEN u.opened_at IS NULL THEN 1 ELSE 0 END) AS sealed_count,
              SUM(CASE WHEN u.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened_count
         FROM sealed_purchases p
         LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
         LEFT JOIN sealed_purchases source_purchase ON source_purchase.id = source_unit.purchase_id AND source_purchase.user_id = p.user_id
         LEFT JOIN sealed_units u ON u.purchase_id = p.id
        WHERE p.user_id = ?
        GROUP BY p.id
        ORDER BY p.purchase_date DESC, p.created_at DESC`,
      [req.user.id]
    );
    const expansionRows = await db.all(
      `SELECT p.id AS purchase_id, NULLIF(TRIM(p.set_name), '') AS expansion
         FROM sealed_purchases p
        WHERE p.user_id = ? AND NULLIF(TRIM(p.set_name), '') IS NOT NULL
       UNION
       SELECT parent.id AS purchase_id, NULLIF(TRIM(child.set_name), '') AS expansion
         FROM sealed_purchases parent
         JOIN sealed_units unit ON unit.purchase_id = parent.id
         JOIN sealed_purchases child ON child.source_unit_id = unit.id AND child.user_id = parent.user_id
        WHERE parent.user_id = ? AND NULLIF(TRIM(child.set_name), '') IS NOT NULL
       UNION
       SELECT p.id AS purchase_id, NULLIF(TRIM(card.set_name), '') AS expansion
         FROM sealed_purchases p
         JOIN sealed_templates template ON template.id = p.template_id
         JOIN sealed_template_components component ON component.template_id = template.id AND component.component_type = 'card'
         JOIN card_cache card ON card.id = component.card_id
        WHERE p.user_id = ? AND NULLIF(TRIM(card.set_name), '') IS NOT NULL
       UNION
       SELECT p.id AS purchase_id, NULLIF(TRIM(catalog.group_name), '') AS expansion
         FROM sealed_purchases p
         JOIN sealed_templates template ON template.id = p.template_id
         JOIN sealed_template_components component ON component.template_id = template.id
          AND component.component_type = 'product' AND component.product_id IS NOT NULL
         JOIN tcgplayer_catalog catalog ON catalog.product_id = component.product_id
        WHERE p.user_id = ? AND NULLIF(TRIM(catalog.group_name), '') IS NOT NULL`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );
    const expansionsByPurchase = new Map();
    for (const row of expansionRows) {
      const expansions = expansionsByPurchase.get(row.purchase_id) || new Set();
      expansions.add(row.expansion);
      expansionsByPurchase.set(row.purchase_id, expansions);
    }
    for (const purchase of purchases) {
      purchase.expansions = [...(expansionsByPurchase.get(purchase.id) || [])].sort((a, b) => a.localeCompare(b));
    }
    res.json({ purchases });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sealed purchases', message: error.message });
  }
});

router.get('/sealed/purchases/:id', async (req, res) => {
  try {
    const purchase = await db.get(
      `SELECT * FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const units = await db.all(
      `SELECT id, opened_at, created_at FROM sealed_units WHERE purchase_id = ? ORDER BY id ASC`,
      [purchase.id]
    );
    res.json({ purchase, units });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sealed purchase', message: error.message });
  }
});

router.post('/sealed/purchases/:id/refresh-value', async (req, res) => {
  try {
    const purchase = await db.get(
      `SELECT p.id, p.product_id, p.product_name
         FROM sealed_purchases p WHERE p.id = ? AND p.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (!purchase.product_id) return res.status(400).json({ error: 'Market value refresh requires a catalog-linked product' });

    const product = await db.get(
      `SELECT category_id, group_id FROM tcgplayer_catalog WHERE product_id = ? AND number IS NULL`,
      [purchase.product_id]
    );
    if (!product) return res.status(404).json({ error: 'Sealed product is not in the mapped catalog' });

    const prices = await tcgcsv.getPrices(product.category_id, product.group_id);
    const rows = prices.filter(row => Number(row.productId) === Number(purchase.product_id));
    const market = rows.find(row => Number(row.marketPrice) > 0)?.marketPrice
      ?? rows.find(row => Number(row.midPrice) > 0)?.midPrice;
    if (!(Number(market) > 0)) return res.status(404).json({ error: 'No market value is available for this product' });

    await db.run(
      `UPDATE sealed_purchases
          SET market_value = ?, market_value_source = 'tcgcsv', market_value_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`,
      [Number(market), purchase.id, req.user.id]
    );
    const updated = await db.get(`SELECT market_value, market_value_source, market_value_at FROM sealed_purchases WHERE id = ?`, [purchase.id]);
    res.json({ ...updated });
  } catch (error) {
    res.status(502).json({ error: 'Failed to refresh sealed product market value', message: error.message });
  }
});

// Create a purchase and its N identical sealed units in one go. If `product_id`
// is given it's trusted to snapshot name/set/image/type from the catalog at the
// moment of purchase; otherwise the free-text fields carry the whole record.
router.post('/sealed/purchases', async (req, res) => {
  const {
    product_id, product_name, set_name, sealed_type, game = 'pokemon',
    image_url, store = '', purchase_date = '', unit_price = null, quantity = 1, notes = '',
    expected_packs = null, expected_cards = null, contents_note = '', market_value = null,
  } = req.body || {};

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  let name = product_name, setName = set_name, type = sealed_type, image = image_url;

  try {
    if (product_id) {
      const catalogRow = await db.get(
        `SELECT name, group_name, sealed_type, image_url FROM tcgplayer_catalog WHERE product_id = ?`,
        [product_id]
      );
      if (catalogRow) {
        name = name || catalogRow.name;
        setName = setName || catalogRow.group_name;
        type = type || catalogRow.sealed_type;
        image = image || catalogRow.image_url;
      }
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'product_name is required' });
    }
    if (market_value != null && market_value !== '' && (!(Number(market_value) >= 0) || !Number.isFinite(Number(market_value)))) {
      return res.status(400).json({ error: 'market_value must be a number of 0 or more' });
    }
    const trimmedName = String(name).trim();
    const template = await matchTemplate(req.user.id, product_id || null, trimmedName);

    const purchase = await withTransaction(async () => {
      const result = await db.run(
        `INSERT INTO sealed_purchases
           (user_id, product_id, product_name, set_name, sealed_type, game, image_url, store, purchase_date, unit_price, quantity, notes,
            expected_packs, expected_cards, contents_note, template_id, market_value, market_value_source, market_value_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)`,
        [req.user.id, product_id || null, trimmedName, setName || null, type || null, game,
          image || null, store, purchase_date, unit_price, qty, notes,
          expected_packs === '' ? null : expected_packs, expected_cards === '' ? null : expected_cards, contents_note,
           template ? template.id : null,
           market_value === '' || market_value == null ? null : Number(market_value),
           market_value === '' || market_value == null ? null : 'manual',
           market_value === '' || market_value == null ? null : Number(market_value)]
      );
      for (let i = 0; i < qty; i++) {
        await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [result.lastID]);
      }
      return db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [result.lastID]);
    });
    res.status(201).json({ purchase });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create sealed purchase', message: error.message });
  }
});

// Edit purchase-level fields. Changing `quantity` adds or removes units:
// removing is only allowed while enough sealed, unlinked units exist to drop —
// a unit that's been opened or linked to a card carries history that a quantity
// edit must not silently delete.
router.put('/sealed/purchases/:id', async (req, res) => {
  const { store, purchase_date, unit_price, notes, quantity, expected_packs, expected_cards, contents_note, market_value } = req.body || {};
  try {
    const purchase = await db.get(
      `SELECT * FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const sets = [];
    const params = [];
    if (store !== undefined) { sets.push('store = ?'); params.push(store); }
    if (purchase_date !== undefined) { sets.push('purchase_date = ?'); params.push(purchase_date); }
    if (expected_packs !== undefined) { sets.push('expected_packs = ?'); params.push(expected_packs === '' ? null : expected_packs); }
    if (expected_cards !== undefined) { sets.push('expected_cards = ?'); params.push(expected_cards === '' ? null : expected_cards); }
    if (contents_note !== undefined) { sets.push('contents_note = ?'); params.push(contents_note); }
    if (unit_price !== undefined) { sets.push('unit_price = ?'); params.push(unit_price); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
    if (market_value !== undefined) {
      if (market_value != null && market_value !== '' && (!(Number(market_value) >= 0) || !Number.isFinite(Number(market_value)))) {
        return res.status(400).json({ error: 'market_value must be a number of 0 or more' });
      }
      const value = market_value === '' || market_value == null ? null : Number(market_value);
      sets.push('market_value = ?', 'market_value_source = ?', 'market_value_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END');
      params.push(value, value == null ? null : 'manual', value);
    }

    await withTransaction(async () => {
      if (quantity !== undefined) {
        const newQty = Math.max(1, parseInt(quantity, 10) || 1);
        const delta = newQty - purchase.quantity;
        if (delta > 0) {
          for (let i = 0; i < delta; i++) {
            await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.id]);
          }
        } else if (delta < 0) {
          const removable = await db.all(
            `SELECT id FROM sealed_units
               WHERE purchase_id = ? AND opened_at IS NULL
                 AND id NOT IN (SELECT sealed_unit_id FROM collection WHERE sealed_unit_id IS NOT NULL)
               LIMIT ?`,
            [purchase.id, -delta]
          );
          if (removable.length < -delta) {
            throw Object.assign(new Error('Not enough unopened, unlinked units to remove'), { status: 400 });
          }
          for (const u of removable) {
            await db.run(`DELETE FROM sealed_units WHERE id = ?`, [u.id]);
          }
        }
        sets.push('quantity = ?');
        params.push(newQty);
      }
      if (sets.length > 0) {
        params.push(purchase.id, req.user.id);
        await db.run(`UPDATE sealed_purchases SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
      }
    });

    const updated = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [purchase.id]);
    res.json({ purchase: updated });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update sealed purchase', message: error.message });
  }
});

// Attach a sealed purchase to one opened unit that it came from. Keeping this
// relationship on the purchase lets each box instance have different contents.
router.put('/sealed/purchases/:id/source-unit', async (req, res) => {
  const { source_unit_id: sourceUnitId } = req.body || {};
  if (sourceUnitId != null && (!Number.isInteger(Number(sourceUnitId)) || Number(sourceUnitId) < 1)) {
    return res.status(400).json({ error: 'source_unit_id must be a positive integer or null' });
  }

  try {
    const purchase = await db.get(
      `SELECT id, source_unit_id, unit_price, source_unit_price_original, source_unit_price_saved
         FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    let sourceUnit = null;
    if (sourceUnitId != null) {
      sourceUnit = await db.get(
        `SELECT u.id, parent.id AS purchase_id
           FROM sealed_units u
           JOIN sealed_purchases parent ON parent.id = u.purchase_id
          WHERE u.id = ? AND parent.user_id = ? AND u.opened_at IS NOT NULL`,
        [Number(sourceUnitId), req.user.id]
      );
      if (!sourceUnit) return res.status(400).json({ error: 'Source unit must belong to you and be opened' });
      if (Number(sourceUnit.purchase_id) === Number(purchase.id)) {
        return res.status(400).json({ error: 'A purchase cannot be linked to one of its own units' });
      }

      const cycle = await db.get(
        `WITH RECURSIVE descendants(purchase_id) AS (
           SELECT id FROM sealed_purchases WHERE id = ? AND user_id = ?
           UNION
           SELECT child.id
             FROM sealed_purchases child
             JOIN sealed_units child_unit ON child_unit.id = child.source_unit_id
             JOIN descendants parent ON parent.purchase_id = child_unit.purchase_id
            WHERE child.user_id = ?
         )
         SELECT purchase_id FROM descendants WHERE purchase_id = ?`,
        [purchase.id, req.user.id, req.user.id, sourceUnit.purchase_id]
      );
      if (cycle) return res.status(400).json({ error: 'Linking this purchase would create a contents cycle' });
    }

    const newSourceUnitId = sourceUnit?.id || null;
    const originalUnitPrice = purchase.source_unit_price_saved
      ? purchase.source_unit_price_original
      : purchase.unit_price;

    await withTransaction(async () => {
      if (!newSourceUnitId) {
        await db.run(
          `UPDATE sealed_purchases
              SET source_unit_id = NULL, unit_price = ?, source_unit_price_original = NULL, source_unit_price_saved = 0
            WHERE id = ? AND user_id = ?`,
          [originalUnitPrice, purchase.id, req.user.id]
        );
      } else {
        await db.run(
          `UPDATE sealed_purchases
              SET source_unit_id = ?, source_unit_price_original = ?, source_unit_price_saved = 1
            WHERE id = ? AND user_id = ?`,
          [newSourceUnitId, originalUnitPrice, purchase.id, req.user.id]
        );
      }

      const affectedUnits = new Set([purchase.source_unit_id, newSourceUnitId].filter(Boolean));
      for (const unitId of affectedUnits) {
        const source = await db.get(
          `SELECT u.id, p.unit_price
             FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
            WHERE u.id = ? AND p.user_id = ?`,
          [unitId, req.user.id]
        );
        if (source?.unit_price != null) {
          await allocateSealedUnitCost(source.id, req.user.id, source.unit_price);
        }
      }
    });
    const updated = await db.get(
      `SELECT unit_price FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [purchase.id, req.user.id]
    );
    res.json({ success: true, source_unit_id: newSourceUnitId, unit_price: updated.unit_price });
  } catch (error) {
    res.status(500).json({ error: 'Failed to link sealed purchase', message: error.message });
  }
});

// Cascades to sealed_units (ON DELETE CASCADE); any collection rows linked to
// those units keep the card, just losing the link (ON DELETE SET NULL).
router.delete('/sealed/purchases/:id', async (req, res) => {
  try {
    const result = await db.run(
      `DELETE FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Purchase not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete sealed purchase', message: error.message });
  }
});

// Toggle a unit's opened/sealed status. Reopening reconciles missing product
// components without duplicating existing children or guaranteed cards.
router.put('/sealed/units/:id/open', async (req, res) => {
  const opened = req.body?.opened !== false;
  try {
    const unit = await db.get(
      `SELECT u.* FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
        WHERE u.id = ? AND p.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    let applied = null;
    await withTransaction(async () => {
      await db.run(
        `UPDATE sealed_units SET opened_at = ? WHERE id = ?`,
        [opened ? new Date().toISOString() : null, unit.id]
      );
      if (opened) {
        const purchase = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [unit.purchase_id]);
        let template = purchase?.template_id
          ? await db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [purchase.template_id])
          : null;
        if (template) {
          template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
        } else if (purchase) {
          template = await matchTemplate(purchase.user_id, purchase.product_id, purchase.product_name);
          if (template) await db.run(`UPDATE sealed_purchases SET template_id = ? WHERE id = ?`, [template.id, purchase.id]);
        }
        {
          if (template) {
            const freshUnit = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [unit.id]);
            const newlyApplied = await applyTemplateComponents(freshUnit, purchase, template, {
              includeCards: !unit.components_applied_at,
            });
            if (newlyApplied.length > 0) applied = newlyApplied;
          }
        }
      }
    });

    const updated = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [unit.id]);
    res.json({ unit: updated, applied });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update sealed unit', message: error.message });
  }
});

// The cards already pulled from this unit, so "what did I open and link" is
// answerable without hunting through the whole collection.
router.get('/sealed/units/:id/cards', async (req, res) => {
  try {
    const unit = await db.get(
      `SELECT u.id FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id WHERE u.id = ? AND p.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    const cards = await db.all(
      `SELECT c.id AS entry_id, c.quantity, c.condition, c.printing, c.purchase_price,
              cc.name, cc.set_name, cc.image_url
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.sealed_unit_id = ? AND c.user_id = ?
        ORDER BY c.added_at DESC`,
      [unit.id, req.user.id]
    );
    res.json({ cards });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch linked cards', message: error.message });
  }
});

// Opened units with no cards linked yet, for the "link cards from this pack"
// picker — joined with their purchase for display (store, date, product name).
router.get('/sealed/units', async (req, res) => {
  const { opened, unlinked } = req.query;
  const where = [`p.user_id = ?`];
  const params = [req.user.id];
  if (opened === '1') where.push(`u.opened_at IS NOT NULL`);
  if (opened === '0') where.push(`u.opened_at IS NULL`);
  if (unlinked === '1') where.push(`(
    p.expected_cards IS NULL
      AND u.id NOT IN (SELECT sealed_unit_id FROM collection WHERE sealed_unit_id IS NOT NULL)
    OR p.expected_cards IS NOT NULL
      AND COALESCE((SELECT SUM(c.quantity) FROM collection c WHERE c.sealed_unit_id = u.id AND c.user_id = p.user_id), 0) < p.expected_cards
  )`);
  try {
    const units = await db.all(
      `SELECT u.id, u.opened_at, u.created_at,
              (SELECT COUNT(*) FROM sealed_units earlier_unit
                WHERE earlier_unit.purchase_id = p.id AND earlier_unit.id <= u.id) AS unit_number,
              p.id AS purchase_id, p.product_name, p.set_name, p.game, p.image_url,
              p.store, p.purchase_date, p.unit_price, p.expected_cards,
              COALESCE((SELECT SUM(c.quantity) FROM collection c WHERE c.sealed_unit_id = u.id AND c.user_id = p.user_id), 0) AS linked_cards
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
        WHERE ${where.join(' AND ')}
        ORDER BY u.opened_at DESC`,
      params
    );
    res.json({ units });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sealed units', message: error.message });
  }
});

// Totals for a sealed-inventory summary panel: overall spend, spend by store,
// spend by game, and how much of it is still sealed vs already opened.
router.get('/sealed/stats', async (req, res) => {
  try {
    const totals = await db.get(
      `SELECT COALESCE(SUM(unit_price * quantity), 0) AS total_spent,
              COALESCE(SUM(quantity), 0) AS total_units
         FROM sealed_purchases WHERE user_id = ?`,
      [req.user.id]
    );
    const byStore = await db.all(
      `SELECT COALESCE(NULLIF(store, ''), 'Unknown') AS store, SUM(unit_price * quantity) AS spent
         FROM sealed_purchases WHERE user_id = ? GROUP BY store ORDER BY spent DESC`,
      [req.user.id]
    );
    const byGame = await db.all(
      `SELECT game, SUM(unit_price * quantity) AS spent
         FROM sealed_purchases WHERE user_id = ? GROUP BY game ORDER BY spent DESC`,
      [req.user.id]
    );
    const sealedVsOpened = await db.get(
      `SELECT
          SUM(CASE WHEN u.opened_at IS NULL THEN p.unit_price ELSE 0 END) AS sealed_value,
          SUM(CASE WHEN u.opened_at IS NOT NULL THEN p.unit_price ELSE 0 END) AS opened_value
        FROM sealed_units u JOIN sealed_purchases p ON p.id = u.purchase_id
       WHERE p.user_id = ?`,
      [req.user.id]
    );
    res.json({
      totalSpent: totals.total_spent || 0,
      totalUnits: totals.total_units || 0,
      byStore,
      byGame,
      sealedValue: sealedVsOpened?.sealed_value || 0,
      openedValue: sealedVsOpened?.opened_value || 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sealed stats', message: error.message });
  }
});

// Does this product already have a saved recipe? Used by the purchase form to
// show "this product has a saved recipe" instead of a blank "define contents".
router.get('/sealed/templates/match', async (req, res) => {
  const { product_id, product_name } = req.query;
  try {
    const template = await matchTemplate(req.user.id, product_id ? Number(product_id) : null, product_name || '');
    res.json({ template });
  } catch (error) {
    res.status(500).json({ error: 'Failed to match template', message: error.message });
  }
});

router.get('/sealed/templates', async (req, res) => {
  try {
    const templates = await db.all(`SELECT * FROM sealed_templates WHERE user_id = ? ORDER BY product_name ASC`, [req.user.id]);
    for (const t of templates) {
      t.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [t.id]);
    }
    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch templates', message: error.message });
  }
});

const COMPONENT_TYPES = ['card', 'product'];

// Create (or replace, if one already exists for this product) a template and
// its components in one call — the editor always sends the full component
// list, so wholesale delete+reinsert is simpler and no less correct than a diff.
router.post('/sealed/templates', async (req, res) => {
  const { product_id = null, product_name, game = 'pokemon', components = [] } = req.body || {};
  if (!product_name || !String(product_name).trim()) {
    return res.status(400).json({ error: 'product_name is required' });
  }
  if (!Array.isArray(components) || components.length === 0) {
    return res.status(400).json({ error: 'At least one component is required' });
  }
  for (const c of components) {
    if (!COMPONENT_TYPES.includes(c.component_type)) {
      return res.status(400).json({ error: `Invalid component_type. One of: ${COMPONENT_TYPES.join(', ')}` });
    }
  }
  try {
    const existing = await matchTemplate(req.user.id, product_id, String(product_name).trim());
    const template = await withTransaction(async () => {
      let templateId = existing?.id;
      if (templateId) {
        await db.run(`DELETE FROM sealed_template_components WHERE template_id = ?`, [templateId]);
      } else {
        const result = await db.run(
          `INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, ?, ?, ?)`,
          [req.user.id, product_id || null, String(product_name).trim(), game]
        );
        templateId = result.lastID;
      }
      for (const c of components) {
        const qty = Math.max(1, parseInt(c.quantity, 10) || 1);
        await db.run(
            `INSERT INTO sealed_template_components (template_id, component_type, quantity, card_id, product_name, sealed_type, product_id, game, expected_cards)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [templateId, c.component_type, qty, c.card_id || null, c.product_name || null, c.sealed_type || null, c.product_id || null, c.game || null,
              c.expected_cards == null || c.expected_cards === '' ? null : Math.max(0, parseInt(c.expected_cards, 10) || 0)]
        );
      }
      // Attach purchases made before this recipe existed (e.g. imports).
      if (product_id) {
        await db.run(
          `UPDATE sealed_purchases SET template_id = ? WHERE user_id = ? AND template_id IS NULL AND product_id = ?`,
          [templateId, req.user.id, product_id]
        );
      } else {
        await db.run(
          `UPDATE sealed_purchases SET template_id = ? WHERE user_id = ? AND template_id IS NULL AND product_id IS NULL AND product_name = ?`,
          [templateId, req.user.id, String(product_name).trim()]
        );
      }
      return db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [templateId]);
    });
    template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
    res.status(201).json({ template });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save template', message: error.message });
  }
});

// One template by id, for displaying "this purchase's recipe" on a purchase card.
router.get('/sealed/templates/:id', async (req, res) => {
  try {
    const template = await db.get(`SELECT * FROM sealed_templates WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
    res.json({ template });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch template', message: error.message });
  }
});

router.delete('/sealed/templates/:id', async (req, res) => {
  try {
    const result = await db.run(`DELETE FROM sealed_templates WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete template', message: error.message });
  }
});

module.exports = router;
