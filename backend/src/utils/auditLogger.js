const db = require('../db');

async function logAuditEvent(userId, actionType, entityType, entityId, beforeState, afterState, database) {
  const dbClient = database || db;
  await dbClient.run(
    `INSERT INTO audit_logs (user_id, action_type, entity_type, entity_id, before_state, after_state)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      actionType,
      entityType,
      entityId,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null
    ]
  );
}

async function revertAuditEvent(req, res) {
  const auditId = req.params.id;
  const userId = req.user.id;

  try {
    const log = await db.get(`SELECT * FROM audit_logs WHERE id = ? AND user_id = ?`, [auditId, userId]);
    if (!log || !log.before_state) {
      return res.status(400).json({ error: 'Audit event cannot be reverted or not found' });
    }

    const snapshot = JSON.parse(log.before_state);

    await db.withTransaction(async (tx) => {
      if (log.action_type === 'DELETE') {
        await tx.run(
          `INSERT INTO collection (id, card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, is_trade, list_type, game)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [snapshot.id, snapshot.card_id, snapshot.user_id, snapshot.quantity, snapshot.condition, snapshot.printing, snapshot.language, snapshot.purchase_price || 0, snapshot.location_id || null, snapshot.compartment_id || null, snapshot.position || null, snapshot.is_trade || 0, snapshot.list_type || 'collection', snapshot.game || 'pokemon']
        );
      } else if (log.action_type === 'UPDATE' || log.action_type === 'BULK_MOVE') {
        await tx.run(
          `UPDATE collection 
           SET location_id = ?, compartment_id = ?, position = ?, quantity = ?, condition = ?, printing = ?, is_trade = ?, list_type = ? 
           WHERE id = ? AND user_id = ?`,
          [snapshot.location_id, snapshot.compartment_id, snapshot.position, snapshot.quantity, snapshot.condition, snapshot.printing, snapshot.is_trade || 0, snapshot.list_type || 'collection', snapshot.id, userId]
        );
      }

      await logAuditEvent(userId, 'REVERT', log.entity_type, log.entity_id, log.after_state ? JSON.parse(log.after_state) : null, snapshot, tx);
    });

    return res.json({ success: true, message: 'Operation successfully reverted' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to revert audit event', message: error.message });
  }
}

async function getAuditLogs(req, res) {
  const userId = req.user.id;
  try {
    const logs = await db.all(
      `SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
    return res.json({ logs });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch audit logs', message: error.message });
  }
}

module.exports = {
  logAuditEvent,
  revertAuditEvent,
  getAuditLogs
};
