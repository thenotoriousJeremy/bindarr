import sys
import re

with open('backend/src/routes/collection.js', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """// Replaces the full set of sets assigned to a compartment in one call —
// the sort assistant then prefers this compartment for cards from those
// sets (see compartmentSort.recommendSlot).
router.put('/compartments/:id/sets', async (req, res) => {
  const { id } = req.params;
  const { sets = [] } = req.body;
  try {
    const compartment = await db.get(`
      SELECT cp.id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

    await db.run(`DELETE FROM compartment_set_assignments WHERE compartment_id = ?`, [id]);
    for (const setName of sets) {
      await db.run(`INSERT OR IGNORE INTO compartment_set_assignments (compartment_id, set_name) VALUES (?, ?)`, [id, setName]);
    }
    res.json({ message: 'Set assignments updated', sets });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update set assignments' });
  }
});"""

replacement1 = """// Replaces the full set of categories assigned to a compartment in one call —
// the sort assistant then prefers this compartment for matching cards.
router.put('/compartments/:id/filters', async (req, res) => {
  const { id } = req.params;
  const { filters = [] } = req.body;
  try {
    const compartment = await db.get(`
      SELECT cp.id FROM compartments cp
      JOIN locations l ON cp.location_id = l.id
      WHERE cp.id = ? AND l.user_id = ?
    `, [id, req.user.id]);
    if (!compartment) return res.status(404).json({ error: 'Compartment not found' });

    await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [id]);
    for (const filterValue of filters) {
      await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [id, filterValue]);
    }
    res.json({ message: 'Filter assignments updated', filters });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update filter assignments' });
  }
});"""

if target1 in content:
    content = content.replace(target1, replacement1)
    print("Updated /compartments/:id/filters in collection.js")
else:
    print("Target 1 not found in collection.js")

with open('backend/src/routes/collection.js', 'w', encoding='utf-8') as f:
    f.write(content)
