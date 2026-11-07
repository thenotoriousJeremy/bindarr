const db = require('../db');
const { splitPrice } = require('./splitPrice');
const { productCardCount, templateCardCount } = require('./sealedContents');

async function allocateSealedUnitCost(unitId, userId, total, method = 'equal') {
  const source = await db.get(
    `SELECT p.expected_cards, p.template_id, p.product_id, p.product_name
       FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE u.id = ? AND p.user_id = ?`,
    [unitId, userId]
  );
  if (!source) return { linkedRows: [], cardCount: 0, componentCount: 0 };

  const linkedRows = await db.all(
    `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
       LEFT JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.sealed_unit_id = ? AND c.user_id = ?`,
    [unitId, userId]
  );
  const childPurchases = await db.all(
    `SELECT p.id, p.product_id, p.product_name, p.expected_cards, COUNT(u.id) AS unit_count
       FROM sealed_purchases p
       JOIN sealed_units u ON u.purchase_id = p.id
      WHERE p.source_unit_id = ? AND p.user_id = ?
      GROUP BY p.id`,
    [unitId, userId]
  );
  for (const purchase of childPurchases) {
    purchase.cardCount = await productCardCount(userId, purchase.product_id, purchase.product_name, purchase.expected_cards);
  }
  const childCardCount = childPurchases.reduce((sum, purchase) =>
    sum + purchase.cardCount * Number(purchase.unit_count), 0);
  const cardCount = linkedRows.reduce((sum, row) => sum + Math.max(1, Number(row.quantity) || 1), 0);
  const componentCount = cardCount + childCardCount;
  if (componentCount === 0) return { linkedRows, cardCount, componentCount };

  let boxCardCount = Math.max(0, Number(source.expected_cards) || 0);
  if (boxCardCount === 0) {
    let templateId = source.template_id;
    if (!templateId) {
      const template = source.product_id
        ? await db.get(
          `SELECT id FROM sealed_templates WHERE user_id = ? AND product_id = ?`,
          [userId, source.product_id]
        )
        : await db.get(
          `SELECT id FROM sealed_templates WHERE user_id = ? AND product_id IS NULL AND product_name = ?`,
          [userId, source.product_name]
        );
      templateId = template?.id;
    }
    if (templateId) boxCardCount = await templateCardCount(userId, templateId);
  }
  // When the box has no known total, preserve the previous behavior by treating
  // its linked contents as the full allocation basis. Never allocate more than
  // the box price if the recorded contents exceed the stated total.
  const allocationCardCount = Math.max(boxCardCount, componentCount);
  const totalPrice = Math.round(Number(total) * 100) / 100;
  const cardTotal = childCardCount || boxCardCount
    ? Math.round(totalPrice * cardCount / allocationCardCount * 100) / 100
    : totalPrice;
  if (linkedRows.length) {
    const copyPrices = linkedRows.flatMap(row =>
      Array(Math.max(1, Number(row.quantity) || 1)).fill(row.price || 0));
    const copyShares = splitPrice(copyPrices, cardTotal, method);
    let copyOffset = 0;
    for (let i = 0; i < linkedRows.length; i++) {
      const quantity = Math.max(1, Number(linkedRows[i].quantity) || 1);
      const rowCost = copyShares.slice(copyOffset, copyOffset + quantity).reduce((sum, share) => sum + share, 0);
      copyOffset += quantity;
      await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [rowCost / quantity, linkedRows[i].id, userId]);
    }
  }
  if (childCardCount) {
    const childTotal = componentCount >= allocationCardCount
      ? totalPrice - cardTotal
      : totalPrice * childCardCount / allocationCardCount;
    const pricePerCard = childTotal / childCardCount;
    for (const purchase of childPurchases) {
      const childUnitPrice = pricePerCard * purchase.cardCount;
      await db.run(`UPDATE sealed_purchases SET unit_price = ? WHERE id = ? AND user_id = ?`, [childUnitPrice, purchase.id, userId]);
    }
  }
  return { linkedRows, cardCount, componentCount };
}

module.exports = { allocateSealedUnitCost };
