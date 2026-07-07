import re
import sys

with open('backend/src/routes/collection.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update resolveCompartmentAndPosition signature and logic
old_resolve = """async function resolveCompartmentAndPosition({ locationId, compartmentId, position, userId, cardId, printing }) {
  if (compartmentId !== undefined && compartmentId !== null) {
    // A caller-supplied compartment can go stale (the location/compartment was
    // deleted after the client picked it) — verify it still exists rather than
    // trusting it into an INSERT and blowing up the compartment_id FK.
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, userId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };
    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label };
    const countRow = await db.get(`SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartmentId, userId]);
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label };
  }"""

new_resolve = """async function resolveCompartmentAndPosition({ locationId, compartmentId, position, userId, cardId, printing, excludeEntryId }) {
  if (compartmentId !== undefined && compartmentId !== null) {
    // A caller-supplied compartment can go stale (the location/compartment was
    // deleted after the client picked it) — verify it still exists rather than
    // trusting it into an INSERT and blowing up the compartment_id FK.
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, userId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };
    
    let countQuery = `SELECT COUNT(*) as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`;
    let countParams = [compartmentId, userId];
    if (excludeEntryId) {
      countQuery += ` AND id != ?`;
      countParams.push(excludeEntryId);
    }
    const countRow = await db.get(countQuery, countParams);
    if (countRow.cnt >= compartment.capacity) {
      throw new Error('COMPARTMENT_FULL');
    }

    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label };
  }"""

content = content.replace(old_resolve, new_resolve)

# 2. Update PUT /collection/:id
content = content.replace(
    "cardId: entry.card_id,\n        printing: printing !== undefined ? printing : entry.printing\n      });",
    "cardId: entry.card_id,\n        printing: printing !== undefined ? printing : entry.printing,\n        excludeEntryId: id\n      });"
)
content = content.replace(
    "res.status(500).json({ error: 'Failed to update collection entry' });",
    "if (error.message === 'COMPARTMENT_FULL') return res.status(400).json({ error: 'Compartment is full' });\n    res.status(500).json({ error: 'Failed to update collection entry' });"
)

# 3. Update POST /collection
content = content.replace(
    "res.status(500).json({ error: 'Failed to add to collection' });",
    "if (error.message === 'COMPARTMENT_FULL') return res.status(400).json({ error: 'Compartment is full' });\n    res.status(500).json({ error: 'Failed to add to collection' });"
)

# 4. Update PUT /:id/move
content = content.replace(
    "cardId: entry.card_id,\n            printing: entry.printing\n          });",
    "cardId: entry.card_id,\n            printing: entry.printing,\n            excludeEntryId: id\n          });"
)
content = content.replace(
    "res.status(500).json({ error: 'Failed to move card' });",
    "if (error.message === 'COMPARTMENT_FULL') return res.status(400).json({ error: 'Compartment is full' });\n    res.status(500).json({ error: 'Failed to move card' });"
)

with open('backend/src/routes/collection.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Backend patched.")
