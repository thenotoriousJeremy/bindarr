import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target_toggle = """  const handleToggleCompartmentSet = async (compartment, setName) => {
    const current = compartment.assignedSets || [];
    const next = current.includes(setName) ? current.filter(s => s !== setName) : [...current, setName];
    try {
      await fetch(`/api/compartments/${compartment.id}/sets`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sets: next }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error updating set assignment.'); }
  };"""

replacement_toggle = """  const handleToggleCompartmentFilter = async (compartment, filterVal) => {
    const current = compartment.assignedFilters || [];
    const next = current.includes(filterVal) ? current.filter(s => s !== filterVal) : [...current, filterVal];
    try {
      await fetch(`/api/compartments/${compartment.id}/filters`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: next }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error updating filter assignment.'); }
  };"""

target_auto = """  const handleAutoAssignSets = async () => {
    if (!selectedLoc) return;
    if (!window.confirm(`Auto-distribute your owned sets across "${selectedLoc.name}"'s compartments by size? This replaces current set assignments.`)) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/auto-assign-sets`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(data.skipped.length ? `Assigned sets. Didn't fit: ${data.skipped.join(', ')}` : 'Sets auto-assigned.');
        await fetchCompartments(selectedLoc.id);
      } else {
        showToast(data.error || 'Failed to auto-assign sets.');
      }
    } catch (err) { console.error(err); showToast('Error auto-assigning sets.'); }
  };"""

replacement_auto = """  const handleAutoAssignCategories = async () => {
    if (!selectedLoc) return;
    if (!window.confirm(`Auto-distribute your owned categories across "${selectedLoc.name}"'s compartments by size? This replaces current assignments.`)) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/auto-assign-categories`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(data.skipped.length ? `Assigned categories. Didn't fit: ${data.skipped.join(', ')}` : 'Categories auto-assigned.');
        await fetchCompartments(selectedLoc.id);
      } else {
        showToast(data.error || 'Failed to auto-assign categories.');
      }
    } catch (err) { console.error(err); showToast('Error auto-assigning categories.'); }
  };"""

content = content.replace(target_toggle, replacement_toggle)
content = content.replace(target_auto, replacement_auto)

# Also update the buttons in LocationManager to use handleAutoAssignCategories
content = content.replace("onClick={handleAutoAssignSets}", "onClick={handleAutoAssignCategories}")
content = content.replace("Auto Assign Sets", "Auto Assign")

# Also update the usages of handleToggleCompartmentSet inside LocationManager render
content = content.replace("handleToggleCompartmentSet(c, setName)", "handleToggleCompartmentFilter(c, filterVal)")
content = content.replace("onToggleSet: (setName) => handleToggleCompartmentSet(c, setName)", "onToggleFilter: (filterVal) => handleToggleCompartmentFilter(c, filterVal)")

# Wait, the Coverflow view might still have `handleToggleCompartmentSet`:
content = content.replace("onChange={(e) => { if (e.target.value) handleToggleCompartmentSet(activeComp, e.target.value); }}", "onChange={(e) => { if (e.target.value) handleToggleCompartmentFilter(activeComp, e.target.value); }}")
content = content.replace("onClick={() => handleToggleCompartmentSet(activeComp, setName)}", "onClick={() => handleToggleCompartmentFilter(activeComp, setName)}")

# Oh, wait! The Coverflow map uses `setName` as variable: `{activeComp.assignedSets.map(setName => (`
# Let's just blindly replace `assignedSets` with `assignedFilters`.
# Wait, I already did that in the previous LocationManager patch? No, I only did it for CompartmentCard/BinderPageContent. Let's do it everywhere!
content = content.replace("activeComp.assignedSets", "activeComp.assignedFilters")
content = content.replace("compartment.assignedSets", "compartment.assignedFilters")

# Let's fix the parameter names in coverflow mapped loop if any.
# It doesn't strictly matter if the variable is named `setName`, it will just be string.

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated LocationManager.jsx toggle handlers")
