const db = require('../db');

const MAX_DEPTH = 6;

async function findTemplate(userId, productId, productName) {
  if (productId) {
    return db.get(`SELECT id FROM sealed_templates WHERE user_id = ? AND product_id = ?`, [userId, productId]);
  }
  if (!productName) return null;
  return db.get(
    `SELECT id FROM sealed_templates WHERE user_id = ? AND product_id IS NULL AND product_name = ?`,
    [userId, productName]
  );
}

// Total cards a recipe yields, recursing into product components that have
// their own recipe (a bundle holding an ETB and a booster bundle). A product
// without a recipe falls back to its manually entered expected_cards, else 1.
// Returns 0 when there is no recipe to count.
async function templateCardCount(userId, templateId, depth = 0, seen = new Set()) {
  if (!templateId || depth > MAX_DEPTH || seen.has(templateId)) return 0;
  const nextSeen = new Set(seen).add(templateId);
  const components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ?`, [templateId]);
  let total = 0;
  for (const c of components) {
    const qty = Math.max(1, Number(c.quantity) || 1);
    if (c.component_type === 'card') {
      if (c.card_id) total += qty;
    } else {
      total += qty * await productCardCount(userId, c.product_id, c.product_name, c.expected_cards, depth + 1, nextSeen);
    }
  }
  return total;
}

async function productCardCount(userId, productId, productName, expectedCards, depth = 0, seen = new Set()) {
  const template = await findTemplate(userId, productId, productName);
  const fromRecipe = template ? await templateCardCount(userId, template.id, depth, seen) : 0;
  return fromRecipe || Math.max(1, Number(expectedCards) || 1);
}

module.exports = { templateCardCount, productCardCount };
