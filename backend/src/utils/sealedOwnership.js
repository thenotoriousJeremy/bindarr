const db = require('../db');

const VISIBLE_UNIT_WHERE = `(
  u.claimed_by_user_id = ?
  OR (
    u.claimed_by_user_id IS NULL
    AND (
      p.user_id = ?
      OR (p.available_to_all = 1 AND u.opened_at IS NULL)
    )
  )
)`;

const OWNED_UNIT_WHERE = `(
  u.claimed_by_user_id = ?
  OR (u.claimed_by_user_id IS NULL AND p.user_id = ?)
)`;

async function getVisibleUnit(userId, unitId) {
  return db.get(
    `SELECT u.*, p.id AS purchase_id, p.user_id AS purchase_owner_id, p.available_to_all,
            p.product_name, p.product_id, p.game, p.template_id, p.expected_cards,
            p.source_unit_id, p.unit_price
       FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE u.id = ? AND ${VISIBLE_UNIT_WHERE}`,
    [unitId, userId, userId]
  );
}

async function getOwnedUnit(userId, unitId) {
  return db.get(
    `SELECT u.*, p.id AS purchase_id, p.user_id AS purchase_owner_id, p.available_to_all,
            p.product_name, p.product_id, p.game, p.template_id, p.expected_cards,
            p.source_unit_id, p.unit_price
       FROM sealed_units u
       JOIN sealed_purchases p ON p.id = u.purchase_id
      WHERE u.id = ? AND ${OWNED_UNIT_WHERE}`,
    [unitId, userId, userId]
  );
}

module.exports = {
  VISIBLE_UNIT_WHERE,
  OWNED_UNIT_WHERE,
  getVisibleUnit,
  getOwnedUnit,
};
