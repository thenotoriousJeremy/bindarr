const express = require('express');
const db = require('../db');
const { withTransaction } = require('../db');
const tcgcsv = require('../tcgcsvApi');
const { productCardCount, unitCardProgress } = require('../utils/sealedContents');
const { allocateSealedUnitCost } = require('../utils/sealedCostAllocation');
const {
  VISIBLE_UNIT_WHERE,
  OWNED_UNIT_WHERE,
  getVisibleUnit,
  getOwnedUnit,
} = require('../utils/sealedOwnership');

const router = express.Router();

const GAMES = ['pokemon', 'mtg', 'lorcana'];
// Units, extra units and recipe components are written one row each inside a
// write transaction on the shared connection, so the count is bounded: nobody
// buys more than a thousand of one product in one go, and an unbounded value
// would hold the database for as long as the loop takes.
const MAX_QUANTITY = 1000;
const MAX_TEMPLATE_COMPONENTS = 100;

class ValidationError extends Error {}

// Integer 1..MAX_QUANTITY, or the fallback when the field was not sent.
function parseQuantity(value, field, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
    throw new ValidationError(`${field} must be a whole number from 1 to ${MAX_QUANTITY}`);
  }
  return n;
}

// A finite number >= 0, or null when blank. Prices, card counts and market
// values all share this shape; NaN or Infinity in any of them poisons every
// SUM() the stats and cost-allocation code run over the column.
function parseAmount(value, field, { integer = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new ValidationError(`${field} must be ${integer ? 'a whole number' : 'a number'} of 0 or more`);
  }
  return n;
}

function parseGame(value, fallback = 'pokemon') {
  if (value === undefined || value === null || value === '') return fallback;
  if (!GAMES.includes(value)) throw new ValidationError(`game must be one of: ${GAMES.join(', ')}`);
  return value;
}

// Client-safe failure: a ValidationError (or a deliberate status) carries its own
// message; anything else is logged here and answered with the generic one.
function fail(res, error, fallbackStatus, message) {
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
  if (error && error.clientStatus) return res.status(error.clientStatus).json({ error: error.message });
  console.error(`${message}:`, error);
  return res.status(fallbackStatus).json({ error: message });
}

function assertCanToggleUnit(unit, userId, opened) {
  if (unit.claimed_by_user_id != null && Number(unit.claimed_by_user_id) !== Number(userId)) {
    throw Object.assign(new Error('This sealed unit was claimed by another user'), { status: 409 });
  }
  const isPurchaseOwner = Number(unit.purchase_owner_id) === Number(userId);
  const isUnitClaimant = Number(unit.claimed_by_user_id) === Number(userId);
  if (!isPurchaseOwner && !isUnitClaimant && !unit.available_to_all) {
    throw Object.assign(new Error('Unit not found'), { status: 404 });
  }
  if (!opened && !isPurchaseOwner && !isUnitClaimant) {
    throw Object.assign(new Error('Only the buyer or claimant can reseal this unit'), { status: 403 });
  }
}

// A product's contents the user already matches by product identity: by
// product_id when the purchase is catalog-linked, else an exact product_name
// match. Returns the template plus its components, or null.
async function matchTemplate(userId, productId, productName, game) {
  const template = productId
    ? await db.get(`SELECT * FROM sealed_templates WHERE product_id = ? AND game = ?`, [productId, game || 'pokemon'])
    : await db.get(`SELECT * FROM sealed_templates WHERE product_id IS NULL AND product_name = ? COLLATE NOCASE AND game = ?`, [productName, game || 'pokemon']);
  if (!template) return null;
  const components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
  return { ...template, components };
}

async function assertNoRecipeCycle(productId, productName, game, existingTemplateId, candidateComponents) {
  const templates = await db.all(`SELECT id, product_id, product_name, game FROM sealed_templates`);
  const components = await db.all(`SELECT * FROM sealed_template_components`);
  const componentsByTemplate = new Map();
  for (const component of components) {
    const list = componentsByTemplate.get(component.template_id) || [];
    list.push(component);
    componentsByTemplate.set(component.template_id, list);
  }
  const rootProductId = productId == null || productId === '' ? null : Number(productId);
  const rootName = String(productName).trim().toLowerCase();
  const findTemplate = (childProductId, childProductName, childGame) => {
    const resolvedGame = childGame || game;
    if (childProductId != null) {
      return templates.find(template =>
        Number(template.product_id) === Number(childProductId) && template.game === resolvedGame);
    }
    const normalizedName = String(childProductName || '').trim().toLowerCase();
    return templates.find(template => template.product_id == null
      && template.product_name.toLocaleLowerCase() === normalizedName
      && template.game === resolvedGame);
  };
  const matchesRoot = (childProductId, childProductName, childGame) => {
    if ((childGame || game) !== game) return false;
    if (rootProductId != null) {
      return childProductId != null && Number(childProductId) === rootProductId;
    }
    return childProductId == null
      && String(childProductName || '').trim().toLowerCase() === rootName;
  };
  const visited = new Set();
  const visit = (childProductId, childProductName, childGame) => {
    if (matchesRoot(childProductId, childProductName, childGame)) {
      throw new ValidationError('A recipe cannot contain itself through child products');
    }
    const childTemplate = findTemplate(childProductId, childProductName, childGame);
    if (!childTemplate) return;
    if (Number(childTemplate.id) === Number(existingTemplateId)) {
      throw new ValidationError('A recipe cannot contain itself through child products');
    }
    if (visited.has(childTemplate.id)) return;
    visited.add(childTemplate.id);
    for (const child of componentsByTemplate.get(childTemplate.id) || []) {
      if (child.component_type === 'product') {
        visit(child.product_id, child.product_name, child.game || childTemplate.game);
      }
    }
  };

  for (const component of candidateComponents) {
    if (component.component_type === 'product') {
      visit(component.product_id, component.product_name, component.game || game);
    }
  }
}

// Create every component a template defines for one unit: card components go
// straight into the collection, linked to that unit; product components become
// brand-new sealed purchases (their own units, not priced individually — cost
// basis stays on the parent) that can be opened and linked later like any other
// sealed product. Idempotent via sealed_units.components_applied_at.
// Runs inside the open-unit write transaction, so it must not touch the network:
// every card component arrives already resolved in `resolvedCards` (card_id ->
// resolveCardForAdd result), fetched before the transaction began.
async function applyTemplateComponents(unit, purchase, template, {
  includeCards = true,
  ownerUserId = purchase.user_id,
  resolvedCards = new Map(),
} = {}) {
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
      ownerUserId, component.product_id, component.product_name, component.expected_cards, 0, new Set(), component.game || purchase.game);
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
      const resolved = resolvedCards.get(c.card_id);
      if (!resolved) throw new Error(`recipe card ${c.card_id} was not resolved before the transaction`);
      await addCardToCollection({ id: ownerUserId }, {
        card_id: c.card_id, quantity: c.quantity || 1, game: c.game || purchase.game,
        sealed_unit_id: unit.id, purchase_price: componentUnitPrice,
      }, { resolvedCard: resolved });
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
          [ownerUserId, unit.id, c.game, c.product_id]
        )
        : await db.all(
          `SELECT id, quantity, unit_price FROM sealed_purchases
            WHERE user_id = ? AND source_unit_id = ? AND game = ? AND product_id IS NULL AND product_name = ?`,
          [ownerUserId, unit.id, c.game, name || c.product_name]
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
        [ownerUserId, c.product_id || null, name || c.product_name, setName, type, c.game || purchase.game,
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

async function setUnitOpenState(unit, opened, ownerUserId, resolvedCards = new Map()) {
  await db.run(
    `UPDATE sealed_units SET opened_at = ? WHERE id = ?`,
    [opened ? new Date().toISOString() : null, unit.id]
  );
  if (!opened) return null;

  const purchase = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [unit.purchase_id]);
  let template = purchase?.template_id
    ? await db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [purchase.template_id])
    : null;
  if (template) {
    template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
  } else if (purchase) {
    template = await matchTemplate(purchase.user_id, purchase.product_id, purchase.product_name, purchase.game);
    if (template) {
      await db.run(`UPDATE sealed_purchases SET template_id = ? WHERE id = ?`, [template.id, purchase.id]);
    }
  }
  if (!template) return null;

  const freshUnit = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [unit.id]);
  const applied = await applyTemplateComponents(freshUnit, purchase, template, {
    includeCards: !unit.components_applied_at,
    ownerUserId: ownerUserId || unit.claimed_by_user_id || purchase.user_id,
    resolvedCards,
  });
  return applied.length ? applied : null;
}

function sanitizeSharedPurchase(purchase, userId) {
  purchase.is_owner = Number(purchase.user_id) === Number(userId);
  purchase.is_claimed = !purchase.is_owner && Boolean(purchase.claimed_by_me);
  delete purchase.user_id;
  delete purchase.claimed_by_me;
  return purchase;
}

function purchaseUnitVisibility(userId, showClaimedByOthers) {
  return {
    where: showClaimedByOthers
      ? `(${VISIBLE_UNIT_WHERE} OR (p.user_id = ? AND u.claimed_by_user_id IS NOT NULL AND u.claimed_by_user_id != ?))`
      : VISIBLE_UNIT_WHERE,
    params: showClaimedByOthers ? [userId, userId, userId, userId] : [userId, userId],
  };
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
    fail(res, error, 500, 'Failed to search sealed catalog');
  }
});

// One row per purchase, with how many of its units are still sealed vs opened.
router.get('/sealed/purchases', async (req, res) => {
  try {
    const showClaimedByOthers = req.query.show_claimed_by_others === '1';
    const unitVisibility = purchaseUnitVisibility(req.user.id, showClaimedByOthers);
    const purchases = await db.all(
      `SELECT p.*, buyer.username AS buyer_username,
              CASE WHEN p.user_id = ? THEN 1 ELSE 0 END AS is_owner,
              SUM(CASE WHEN u.claimed_by_user_id = ? THEN 1 ELSE 0 END) AS claimed_by_me,
              source_purchase.product_name AS source_product_name,
              (SELECT COUNT(*) FROM sealed_units earlier_unit
                WHERE earlier_unit.purchase_id = source_purchase.id AND earlier_unit.id <= source_unit.id) AS source_unit_number,
              COUNT(u.id) AS unit_count,
              COUNT(u.id) AS visible_unit_count,
              SUM(CASE WHEN u.id IS NOT NULL AND u.opened_at IS NULL THEN 1 ELSE 0 END) AS sealed_count,
              SUM(CASE WHEN u.id IS NOT NULL AND u.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened_count
         FROM sealed_purchases p
         JOIN users buyer ON buyer.id = p.user_id
         LEFT JOIN sealed_units source_unit ON source_unit.id = p.source_unit_id
         LEFT JOIN sealed_purchases source_purchase ON source_purchase.id = source_unit.purchase_id
         LEFT JOIN sealed_units u ON u.purchase_id = p.id AND ${unitVisibility.where}
        WHERE p.user_id = ? OR u.id IS NOT NULL
        GROUP BY p.id
        ORDER BY p.purchase_date DESC, p.created_at DESC`,
      [req.user.id, req.user.id, ...unitVisibility.params, req.user.id]
    );
    for (const purchase of purchases) sanitizeSharedPurchase(purchase, req.user.id);

    const purchaseIds = purchases.map(purchase => purchase.id);
    const expansionRows = purchaseIds.length
      ? await db.all(
        `SELECT p.id AS purchase_id, NULLIF(TRIM(p.set_name), '') AS expansion
           FROM sealed_purchases p
          WHERE p.id IN (${purchaseIds.map(() => '?').join(',')}) AND NULLIF(TRIM(p.set_name), '') IS NOT NULL
         UNION
         SELECT parent.id AS purchase_id, NULLIF(TRIM(child.set_name), '') AS expansion
           FROM sealed_purchases parent
           JOIN sealed_units unit ON unit.purchase_id = parent.id
           JOIN sealed_purchases child ON child.source_unit_id = unit.id
          WHERE parent.id IN (${purchaseIds.map(() => '?').join(',')}) AND NULLIF(TRIM(child.set_name), '') IS NOT NULL
         UNION
         SELECT p.id AS purchase_id, NULLIF(TRIM(card.set_name), '') AS expansion
           FROM sealed_purchases p
           JOIN sealed_templates template ON template.id = p.template_id
           JOIN sealed_template_components component ON component.template_id = template.id AND component.component_type = 'card'
           JOIN card_cache card ON card.id = component.card_id
          WHERE p.id IN (${purchaseIds.map(() => '?').join(',')}) AND NULLIF(TRIM(card.set_name), '') IS NOT NULL
         UNION
         SELECT p.id AS purchase_id, NULLIF(TRIM(catalog.group_name), '') AS expansion
           FROM sealed_purchases p
           JOIN sealed_templates template ON template.id = p.template_id
           JOIN sealed_template_components component ON component.template_id = template.id
            AND component.component_type = 'product' AND component.product_id IS NOT NULL
           JOIN tcgplayer_catalog catalog ON catalog.product_id = component.product_id
          WHERE p.id IN (${purchaseIds.map(() => '?').join(',')}) AND NULLIF(TRIM(catalog.group_name), '') IS NOT NULL`,
        [...purchaseIds, ...purchaseIds, ...purchaseIds, ...purchaseIds]
      )
      : [];
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
    fail(res, error, 500, 'Failed to fetch sealed purchases');
  }
});

router.get('/sealed/purchases/:id', async (req, res) => {
  try {
    const showClaimedByOthers = req.query.show_claimed_by_others === '1';
    const unitVisibility = purchaseUnitVisibility(req.user.id, showClaimedByOthers);
    const purchase = await db.get(
      `SELECT p.*, buyer.username AS buyer_username,
              CASE WHEN p.user_id = ? THEN 1 ELSE 0 END AS is_owner
         FROM sealed_purchases p
         JOIN users buyer ON buyer.id = p.user_id
        WHERE p.id = ?
          AND (
            p.user_id = ?
            OR EXISTS (
              SELECT 1 FROM sealed_units u
               WHERE u.purchase_id = p.id AND ${unitVisibility.where}
            )
          )`,
      [req.user.id, req.params.id, req.user.id, ...unitVisibility.params]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const units = await db.all(
      `SELECT u.id, u.opened_at, u.created_at, u.claimed_by_user_id,
              claimant.username AS claimed_by_username,
              (SELECT COUNT(*) FROM sealed_units earlier_unit
                WHERE earlier_unit.purchase_id = p.id AND earlier_unit.id <= u.id) AS unit_number,
              CASE WHEN u.claimed_by_user_id = ? THEN 1 ELSE 0 END AS claimed_by_me
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
         LEFT JOIN users claimant ON claimant.id = u.claimed_by_user_id
        WHERE u.purchase_id = ? AND ${unitVisibility.where}
        ORDER BY u.id ASC`,
      [req.user.id, purchase.id, ...unitVisibility.params]
    );
    purchase.unit_count = units.length;
    purchase.visible_unit_count = units.length;
    purchase.claimed_by_me = units.some(unit => unit.claimed_by_me);
    sanitizeSharedPurchase(purchase, req.user.id);
    for (const unit of units) {
      const progress = await unitCardProgress(req.user.id, unit.id);
      unit.expected_cards = progress?.expected_cards ?? null;
      unit.linked_cards = progress?.linked_cards ?? 0;
      unit.can_toggle = unit.claimed_by_user_id == null
        ? Boolean(purchase.is_owner || purchase.available_to_all)
        : Boolean(unit.claimed_by_me);
      unit.can_view_cards = Boolean(unit.claimed_by_me
        || (unit.claimed_by_user_id == null && purchase.is_owner));
    }
    res.json({ purchase, units });
  } catch (error) {
    fail(res, error, 500, 'Failed to fetch sealed purchase');
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
    // Magic/Lorcana prices are only synced while an admin has them turned on.
    if (Object.values(tcgcsv.SEALED_ONLY_CATEGORY).includes(Number(product.category_id))
      && !(await tcgcsv.sealedExtraEnabled())) {
      return res.status(409).json({ error: 'Magic/Lorcana sealed prices are turned off in Instance Settings' });
    }

    // The local TCGCSV cache only (filled by the daily sync, which keeps sealed
    // product prices for every synced category). Never a live request, and never
    // a sync from this request path.
    let prices;
    try {
      prices = await tcgcsv.getPrices(product.category_id, product.group_id);
    } catch (error) {
      if (tcgcsv.isCacheMissError(error)) {
        return res.status(503).json({ error: 'TCGCSV prices have not been synced yet' });
      }
      throw error;
    }
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
    fail(res, error, 500, 'Failed to refresh sealed product market value');
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
    available_to_all = false,
  } = req.body || {};

  let qty, gameValue, unitPrice, expectedPacks, expectedCards, marketValue;
  try {
    qty = parseQuantity(quantity, 'quantity');
    gameValue = parseGame(game);
    unitPrice = parseAmount(unit_price, 'unit_price');
    expectedPacks = parseAmount(expected_packs, 'expected_packs', { integer: true });
    expectedCards = parseAmount(expected_cards, 'expected_cards', { integer: true });
    marketValue = parseAmount(market_value, 'market_value');
  } catch (error) {
    return fail(res, error, 400, 'Invalid sealed purchase');
  }
  let name = product_name, setName = set_name, type = sealed_type, image = image_url;

  try {
    if (![true, false, 0, 1].includes(available_to_all)) {
      return res.status(400).json({ error: 'available_to_all must be a boolean' });
    }
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
    const trimmedName = String(name).trim();
    const template = await matchTemplate(req.user.id, product_id || null, trimmedName, game);

    const purchase = await withTransaction(async () => {
      const result = await db.run(
        `INSERT INTO sealed_purchases
           (user_id, product_id, product_name, set_name, sealed_type, game, image_url, store, purchase_date, unit_price, quantity, notes,
            expected_packs, expected_cards, contents_note, template_id, market_value, market_value_source, market_value_at, available_to_all)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?)`,
        [req.user.id, product_id || null, trimmedName, setName || null, type || null, gameValue,
          image || null, store, purchase_date, unitPrice, qty, notes,
          expectedPacks, expectedCards, contents_note,
          template ? template.id : null,
          marketValue,
          marketValue == null ? null : 'manual',
          marketValue,
          available_to_all ? 1 : 0]
      );
      for (let i = 0; i < qty; i++) {
        await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [result.lastID]);
      }
      return db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [result.lastID]);
    });
    res.status(201).json({ purchase });
  } catch (error) {
    fail(res, error, 500, 'Failed to create sealed purchase');
  }
});

router.put('/sealed/purchases/bulk-sharing', async (req, res) => {
  const { purchase_ids: purchaseIds, available_to_all: availableToAll } = req.body || {};
  if (!Array.isArray(purchaseIds) || purchaseIds.length === 0) {
    return res.status(400).json({ error: 'purchase_ids must be a non-empty array' });
  }
  if (![true, false, 0, 1].includes(availableToAll)) {
    return res.status(400).json({ error: 'available_to_all must be a boolean' });
  }

  const ids = [...new Set(purchaseIds.map(id => Number(id)))];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    return res.status(400).json({ error: 'purchase_ids must contain positive integers' });
  }

  try {
    await withTransaction(async () => {
      const chunkSize = 500;
      for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const owned = await db.all(
          `SELECT id FROM sealed_purchases WHERE user_id = ? AND id IN (${placeholders})`,
          [req.user.id, ...chunk]
        );
        if (owned.length !== chunk.length) {
          throw Object.assign(new Error('One or more purchases were not found'), { status: 404 });
        }
        await db.run(
          `UPDATE sealed_purchases SET available_to_all = ? WHERE user_id = ? AND id IN (${placeholders})`,
          [availableToAll ? 1 : 0, req.user.id, ...chunk]
        );
      }
    });
    res.json({ updated: ids.length, available_to_all: Boolean(availableToAll) });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'Failed to update sharing status',
      message: error.message,
    });
  }
});

// Edit purchase-level fields. Changing `quantity` adds or removes units:
// removing is only allowed while enough sealed, unlinked units exist to drop —
// a unit that's been opened or linked to a card carries history that a quantity
// edit must not silently delete.
router.put('/sealed/purchases/:id', async (req, res) => {
  const { store, purchase_date, unit_price, notes, quantity, expected_packs, expected_cards, contents_note, market_value, available_to_all } = req.body || {};
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
    if (expected_packs !== undefined) { sets.push('expected_packs = ?'); params.push(parseAmount(expected_packs, 'expected_packs', { integer: true })); }
    if (expected_cards !== undefined) { sets.push('expected_cards = ?'); params.push(parseAmount(expected_cards, 'expected_cards', { integer: true })); }
    if (contents_note !== undefined) { sets.push('contents_note = ?'); params.push(contents_note); }
    if (unit_price !== undefined) { sets.push('unit_price = ?'); params.push(parseAmount(unit_price, 'unit_price')); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
    if (available_to_all !== undefined) {
      if (![true, false, 0, 1].includes(available_to_all)) {
        return res.status(400).json({ error: 'available_to_all must be a boolean' });
      }
      sets.push('available_to_all = ?');
      params.push(available_to_all ? 1 : 0);
    }
    const newQty = quantity !== undefined ? parseQuantity(quantity, 'quantity', purchase.quantity) : null;
    if (market_value !== undefined) {
      const value = parseAmount(market_value, 'market_value');
      sets.push('market_value = ?', 'market_value_source = ?', 'market_value_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END');
      params.push(value, value == null ? null : 'manual', value);
    }

    await withTransaction(async () => {
      if (newQty != null) {
        const delta = newQty - purchase.quantity;
        if (delta > 0) {
          for (let i = 0; i < delta; i++) {
            await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.id]);
          }
        } else if (delta < 0) {
          const removable = await db.all(
            `SELECT id FROM sealed_units
               WHERE purchase_id = ? AND opened_at IS NULL
                 AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)
                 AND id NOT IN (SELECT sealed_unit_id FROM collection
                                 WHERE sealed_unit_id IS NOT NULL AND user_id = ?)
               LIMIT ?`,
            [purchase.id, req.user.id, req.user.id, -delta]
          );
          if (removable.length < -delta) {
            throw Object.assign(new Error('Not enough unopened, unlinked units to remove'), { clientStatus: 400 });
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
    fail(res, error, 500, 'Failed to update sealed purchase');
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
      sourceUnit = await getOwnedUnit(req.user.id, Number(sourceUnitId));
      if (!sourceUnit || sourceUnit.opened_at == null) {
        return res.status(400).json({ error: 'Source unit must belong to you and be opened' });
      }
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
        const source = await getOwnedUnit(req.user.id, unitId);
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
    fail(res, error, 500, 'Failed to link sealed purchase');
  }
});

// Cascades to sealed_units (ON DELETE CASCADE); any collection rows linked to
// those units keep the card, just losing the link (ON DELETE SET NULL).
router.delete('/sealed/purchases/:id', async (req, res) => {
  try {
    const purchase = await db.get(
      `SELECT id FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    const claimedByOthers = await db.get(
      `SELECT 1 FROM sealed_units WHERE purchase_id = ? AND claimed_by_user_id IS NOT NULL AND claimed_by_user_id != ? LIMIT 1`,
      [purchase.id, req.user.id]
    );
    if (claimedByOthers) {
      return res.status(409).json({ error: 'This purchase has units claimed by other users and cannot be deleted' });
    }
    const result = await db.run(
      `DELETE FROM sealed_purchases WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Purchase not found' });
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 500, 'Failed to delete sealed purchase');
  }
});

// Toggle a unit's opened/sealed status. Reopening reconciles missing product
// components without duplicating existing children or guaranteed cards.
router.put('/sealed/units/:id/open', async (req, res) => {
  const opened = req.body?.opened !== false;
  try {
    const visibleUnit = await getVisibleUnit(req.user.id, req.params.id);
    const unit = visibleUnit;
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    assertCanToggleUnit(unit, req.user.id, opened);

    // Everything that can reach a card provider happens here, BEFORE the write
    // transaction: resolving the recipe and hydrating/fetching each of its card
    // components. BEGIN IMMEDIATE holds the one shared connection, so a provider
    // request inside it would stall every other query in the process for as long
    // as the provider takes. A card that cannot be resolved fails the request
    // here, before anything is written, which keeps the open all-or-nothing.
    const purchase = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [unit.purchase_id]);
    let template = null;
    let attachTemplate = false;
    const resolvedCards = new Map();
    const includeCards = !unit.components_applied_at;
    if (opened) {
      template = purchase?.template_id
        ? await db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [purchase.template_id])
        : null;
      if (template) {
        template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
      } else if (purchase) {
        template = await matchTemplate(purchase.user_id, purchase.product_id, purchase.product_name, purchase.game);
        attachTemplate = !!template;
      }
      if (template && includeCards) {
        const { resolveCardForAdd } = require('./collection');
        const user = { id: req.user.id, tcg_api_key: req.user.tcg_api_key };
        for (const c of template.components) {
          if (c.component_type !== 'card' || !c.card_id || resolvedCards.has(c.card_id)) continue;
          resolvedCards.set(c.card_id, await resolveCardForAdd(user, { card_id: c.card_id, game: c.game || purchase.game }));
        }
      }
    }

    let applied = null;
    let updated = null;
    await withTransaction(async () => {
      let unit = await getVisibleUnit(req.user.id, req.params.id);
      if (!unit) throw Object.assign(new Error('Unit not found'), { status: 404 });
      assertCanToggleUnit(unit, req.user.id, opened);
      if (unit.claimed_by_user_id == null
        && (opened || (Number(unit.purchase_owner_id) === Number(req.user.id) && unit.opened_at != null))) {
        const claim = await db.run(
          `UPDATE sealed_units SET claimed_by_user_id = ?
            WHERE id = ? AND claimed_by_user_id IS NULL`,
          [req.user.id, unit.id]
        );
        if (claim.changes !== 1) {
          throw Object.assign(new Error('This sealed unit was claimed by another user'), { status: 409 });
        }
        unit = await getVisibleUnit(req.user.id, unit.id);
      }
      if (opened && attachTemplate) {
        await db.run(`UPDATE sealed_purchases SET template_id = ? WHERE id = ?`, [template.id, unit.purchase_id]);
      }
      applied = await setUnitOpenState(unit, opened, req.user.id, resolvedCards);
      updated = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [unit.id]);
    });

    res.json({ unit: updated, applied });
  } catch (error) {
    const { AddCardError } = require('./collection');
    if (AddCardError && error instanceof AddCardError) return res.status(error.status).json({ error: error.message });
    if (error.status) return res.status(error.status).json({ error: error.message, message: error.message });
    fail(res, error, 500, 'Failed to update sealed unit');
  }
});

router.put('/sealed/purchases/:id/open-all', async (req, res) => {
  try {
    const purchase = await db.get(
      `SELECT * FROM sealed_purchases WHERE id = ?`,
      [req.params.id]
    );
    if (!purchase || (Number(purchase.user_id) !== Number(req.user.id) && !purchase.available_to_all)) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    const candidateUnits = await db.all(
      `SELECT * FROM sealed_units
        WHERE purchase_id = ? AND opened_at IS NULL
          AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)
        ORDER BY id`,
      [purchase.id, req.user.id]
    );
    const resolvedCards = new Map();
    if (candidateUnits.some(unit => !unit.components_applied_at)) {
      let template = purchase.template_id
        ? await db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [purchase.template_id])
        : await matchTemplate(purchase.user_id, purchase.product_id, purchase.product_name, purchase.game);
      if (template) {
        template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
        const { resolveCardForAdd } = require('./collection');
        const user = { id: req.user.id, tcg_api_key: req.user.tcg_api_key };
        for (const component of template.components) {
          if (component.component_type !== 'card' || !component.card_id || resolvedCards.has(component.card_id)) continue;
          resolvedCards.set(component.card_id, await resolveCardForAdd(user, {
            card_id: component.card_id,
            game: component.game || purchase.game,
          }));
        }
      }
    }

    const result = await withTransaction(async () => {
      const currentPurchase = await db.get(`SELECT * FROM sealed_purchases WHERE id = ?`, [purchase.id]);
      if (!currentPurchase
        || (Number(currentPurchase.user_id) !== Number(req.user.id) && !currentPurchase.available_to_all)) {
        throw Object.assign(new Error('Purchase not found'), { status: 404 });
      }
      const units = await db.all(
        `SELECT * FROM sealed_units
          WHERE purchase_id = ? AND opened_at IS NULL
            AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)
          ORDER BY id`,
        [purchase.id, req.user.id]
      );
      const applied = [];
      for (const unit of units) {
        if (unit.claimed_by_user_id == null) {
          await db.run(`UPDATE sealed_units SET claimed_by_user_id = ? WHERE id = ?`, [req.user.id, unit.id]);
        }
        const claimedUnit = await db.get(`SELECT * FROM sealed_units WHERE id = ?`, [unit.id]);
        const components = await setUnitOpenState(claimedUnit, true, req.user.id, resolvedCards);
        if (components) applied.push(...components);
      }
      return { opened: units.length, applied };
    });
    res.json(result);
  } catch (error) {
    const { AddCardError } = require('./collection');
    if (AddCardError && error instanceof AddCardError) return res.status(error.status).json({ error: error.message });
    if (error.status) return res.status(error.status).json({ error: error.message });
    fail(res, error, 500, 'Failed to open all sealed units');
  }
});

// The cards already pulled from this unit, so "what did I open and link" is
// answerable without hunting through the whole collection.
router.get('/sealed/units/:id/cards', async (req, res) => {
  try {
    const unit = await getOwnedUnit(req.user.id, req.params.id);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    const cards = await db.all(
      `SELECT c.id AS entry_id, c.quantity, c.condition, c.printing, c.purchase_price,
              cc.name, cc.set_name, cc.image_url
         FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.sealed_unit_id = ? AND c.user_id = ?
        ORDER BY c.added_at DESC`,
      [unit.id, req.user.id]
    );
    const progress = await unitCardProgress(req.user.id, unit.id);
    res.json({ cards, progress });
  } catch (error) {
    fail(res, error, 500, 'Failed to fetch linked cards');
  }
});

// Opened units with no cards linked yet, for the "link cards from this pack"
// picker — joined with their purchase for display (store, date, product name).
router.get('/sealed/units', async (req, res) => {
  const { opened, unlinked } = req.query;
  const where = [OWNED_UNIT_WHERE];
  const params = [req.user.id, req.user.id];
  if (opened === '1') where.push(`u.opened_at IS NOT NULL`);
  if (opened === '0') where.push(`u.opened_at IS NULL`);
  try {
    const units = await db.all(
      `SELECT u.id, u.opened_at, u.created_at, u.claimed_by_user_id,
              claimant.username AS claimed_by_username,
              CASE WHEN u.claimed_by_user_id = ? THEN 1 ELSE 0 END AS claimed_by_me,
              p.user_id AS purchase_owner_id,
              buyer.username AS buyer_username,
              (SELECT COUNT(*) FROM sealed_units earlier_unit
                WHERE earlier_unit.purchase_id = p.id AND earlier_unit.id <= u.id) AS unit_number,
              p.id AS purchase_id, p.product_name, p.set_name, p.game, p.image_url,
              p.store, p.purchase_date, p.unit_price, p.quantity, p.expected_cards,
              p.available_to_all
         FROM sealed_units u
         JOIN sealed_purchases p ON p.id = u.purchase_id
         JOIN users buyer ON buyer.id = p.user_id
         LEFT JOIN users claimant ON claimant.id = u.claimed_by_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY u.opened_at DESC`,
      [req.user.id, ...params]
    );
    for (const unit of units) {
      const progress = await unitCardProgress(req.user.id, unit.id);
      unit.expected_cards = progress?.expected_cards ?? null;
      unit.linked_cards = progress?.linked_cards ?? 0;
      delete unit.purchase_owner_id;
    }
    res.json({
      units: unlinked === '1'
        ? units.filter(unit => unit.expected_cards == null
          ? unit.linked_cards === 0
          : unit.linked_cards < unit.expected_cards)
        : units,
    });
  } catch (error) {
    fail(res, error, 500, 'Failed to fetch sealed units');
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
    fail(res, error, 500, 'Failed to fetch sealed stats');
  }
});

// Does this product already have a saved recipe? Used by the purchase form to
// show "this product has a saved recipe" instead of a blank "define contents".
router.get('/sealed/templates/match', async (req, res) => {
  const { product_id, product_name, game } = req.query;
  try {
    const template = await matchTemplate(req.user.id, product_id ? Number(product_id) : null, product_name || '', game);
    res.json({ template });
  } catch (error) {
    fail(res, error, 500, 'Failed to match template');
  }
});

router.get('/sealed/templates', async (req, res) => {
  try {
    const templates = await db.all(`SELECT * FROM sealed_templates ORDER BY product_name ASC`);
    for (const t of templates) {
      t.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [t.id]);
    }
    res.json({ templates });
  } catch (error) {
    fail(res, error, 500, 'Failed to fetch templates');
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
  if (components.length > MAX_TEMPLATE_COMPONENTS) {
    return res.status(400).json({ error: `A recipe can have at most ${MAX_TEMPLATE_COMPONENTS} components` });
  }
  let templateGame;
  const parsedComponents = [];
  try {
    templateGame = parseGame(game);
    for (const c of components) {
      if (!c || !COMPONENT_TYPES.includes(c.component_type)) {
        throw new ValidationError(`Invalid component_type. One of: ${COMPONENT_TYPES.join(', ')}`);
      }
      parsedComponents.push({
        ...c,
        quantity: parseQuantity(c.quantity, 'component quantity'),
        game: c.game ? parseGame(c.game) : null,
        expected_cards: parseAmount(c.expected_cards, 'component expected_cards', { integer: true }),
      });
    }
    // Opening a unit writes one row per component copy, so bound the recipe's
    // total as well as each line of it.
    const total = parsedComponents.reduce((sum, c) => sum + c.quantity, 0);
    if (total > MAX_QUANTITY) {
      throw new ValidationError(`A recipe can hold at most ${MAX_QUANTITY} items in total`);
    }
  } catch (error) {
    return fail(res, error, 400, 'Invalid recipe');
  }
  try {
    const template = await withTransaction(async () => {
      const existing = await matchTemplate(req.user.id, product_id, String(product_name).trim(), templateGame);
      await assertNoRecipeCycle(
        product_id, String(product_name).trim(), templateGame, existing?.id, parsedComponents
      );
      let templateId = existing?.id;
      if (templateId) {
        await db.run(`DELETE FROM sealed_template_components WHERE template_id = ?`, [templateId]);
      } else {
        const result = await db.run(
          `INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, ?, ?, ?)`,
          [req.user.id, product_id || null, String(product_name).trim(), templateGame]
        );
        templateId = result.lastID;
      }
      for (const c of parsedComponents) {
        await db.run(
            `INSERT INTO sealed_template_components (template_id, component_type, quantity, card_id, product_name, sealed_type, product_id, game, expected_cards)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [templateId, c.component_type, c.quantity, c.card_id || null, c.product_name || null, c.sealed_type || null, c.product_id || null, c.game,
              c.expected_cards]
        );
      }
      // Attach purchases made before this recipe existed (e.g. imports).
      if (product_id) {
        await db.run(
          `UPDATE sealed_purchases SET template_id = ? WHERE template_id IS NULL AND product_id = ? AND game = ?`,
          [templateId, product_id, game]
        );
      } else {
        await db.run(
          `UPDATE sealed_purchases SET template_id = ? WHERE template_id IS NULL AND product_id IS NULL AND product_name = ? COLLATE NOCASE AND game = ?`,
          [templateId, String(product_name).trim(), game]
        );
      }
      return db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [templateId]);
    });
    template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
    res.status(201).json({ template });
  } catch (error) {
    fail(res, error, 500, 'Failed to save template');
  }
});

// One template by id, for displaying "this purchase's recipe" on a purchase card.
router.get('/sealed/templates/:id', async (req, res) => {
  try {
    const template = await db.get(`SELECT * FROM sealed_templates WHERE id = ?`, [req.params.id]);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    template.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [template.id]);
    res.json({ template });
  } catch (error) {
    fail(res, error, 500, 'Failed to fetch template');
  }
});

router.delete('/sealed/templates/:id', async (req, res) => {
  try {
    const result = await db.run(`DELETE FROM sealed_templates WHERE id = ?`, [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (error) {
    fail(res, error, 500, 'Failed to delete template');
  }
});

module.exports = router;
