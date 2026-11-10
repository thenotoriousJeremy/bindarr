const db = require('../db');
const { getVisibleUnit } = require('./sealedOwnership');

const MAX_DEPTH = 6;

async function findTemplate(productId, productName, game) {
  if (productId) {
    return db.get(
      `SELECT id, expected_cards FROM sealed_templates WHERE product_id = ? AND (? IS NULL OR game = ?) ORDER BY id LIMIT 1`,
      [productId, game || null, game || null]
    );
  }
  if (!productName) return null;
  return db.get(
    `SELECT id, expected_cards FROM sealed_templates
      WHERE product_id IS NULL AND product_name = ? COLLATE NOCASE
        AND (? IS NULL OR game = ?)
      ORDER BY id LIMIT 1`,
    [productName, game || null, game || null]
  );
}

// Total cards a recipe yields, recursing into product components that have
// their own recipe (a bundle holding an ETB and a booster bundle).
async function templateCardCount(userId, templateId, depth = 0, seen = new Set()) {
  if (!templateId || depth > MAX_DEPTH || seen.has(templateId)) return 0;
  const nextSeen = new Set(seen).add(templateId);
  const template = await db.get(`SELECT game, expected_cards FROM sealed_templates WHERE id = ?`, [templateId]);
  if (template?.expected_cards != null) return Math.max(0, Number(template.expected_cards) || 0);
  const components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [templateId]);
  let total = 0;
  for (const c of components) {
    const qty = Math.max(1, Number(c.quantity) || 1);
    if (c.component_type === 'card') {
      if (c.card_id) total += qty;
    } else {
      total += qty * await productCardCount(
        userId, c.product_id, c.product_name, c.expected_cards, depth + 1, nextSeen, c.game || template?.game
      );
    }
  }
  return total;
}

async function productCardCount(userId, productId, productName, expectedCards, depth = 0, seen = new Set(), game = null) {
  const template = await findTemplate(productId, productName, game);
  if (template?.expected_cards != null) return Math.max(0, Number(template.expected_cards) || 0);
  const fromRecipe = template ? await templateCardCount(userId, template.id, depth, seen) : 0;
  return fromRecipe || Math.max(1, Number(expectedCards) || 1);
}

async function unitCardProgress(userId, unitId) {
  const unit = await getVisibleUnit(userId, unitId);
  if (!unit) return null;
  const template = unit.template_id
    ? await db.get(`SELECT id, expected_cards FROM sealed_templates WHERE id = ?`, [unit.template_id])
    : await findTemplate(unit.product_id, unit.product_name, unit.game);
  const recipeCardCount = template ? await templateCardCount(userId, template.id) : 0;
  const linkedCards = await db.get(
    `WITH RECURSIVE linked_units(id) AS (
       SELECT ?
       UNION
       SELECT child_unit.id
         FROM linked_units parent
         JOIN sealed_purchases child_purchase ON child_purchase.source_unit_id = parent.id
         JOIN sealed_units child_unit ON child_unit.purchase_id = child_purchase.id
     ),
     linked_owners(id, user_id) AS (
       SELECT unit.id, COALESCE(unit.claimed_by_user_id, purchase.user_id)
         FROM linked_units tree
         JOIN sealed_units unit ON unit.id = tree.id
         JOIN sealed_purchases purchase ON purchase.id = unit.purchase_id
     )
     SELECT COALESCE(SUM(card.quantity), 0) AS count
       FROM collection card
       JOIN linked_owners owner ON owner.id = card.sealed_unit_id AND owner.user_id = card.user_id
      WHERE card.list_type = 'collection'`,
    [unitId]
  );
  return {
    expected_cards: template?.expected_cards != null
      ? Number(template.expected_cards)
      : (recipeCardCount || (unit.expected_cards == null ? null : Number(unit.expected_cards))),
    linked_cards: Number(linkedCards?.count) || 0
  };
}

module.exports = { templateCardCount, productCardCount, unitCardProgress };
