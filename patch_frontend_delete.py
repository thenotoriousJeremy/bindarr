import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

new_func = """  const handleRemoveFromContainer = async (entryId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: null, compartment_id: null })
      });
      if (res.ok) { showToast('Card removed from container.'); await refreshAll(); }
      else {
        const errData = await res.json().catch(()=>({}));
        showToast(errData.error || 'Failed to remove card from container.');
      }
    } catch (err) { console.error(err); showToast('Error updating card.'); }
  };

  const handleDeleteCard = async (entryId) => {"""

content = content.replace("  const handleDeleteCard = async (entryId) => {", new_func)

content = content.replace(
    "onDeleteCard={handleDeleteCard}",
    "onDeleteCard={handleRemoveFromContainer}"
)

content = content.replace(
    "onClick={() => handleDeleteCard(activeCard.entry_id)}",
    "onClick={() => handleRemoveFromContainer(activeCard.entry_id)}"
)

# And in BinderPageContent:
content = content.replace(
    """<button type="button" onClick={() => onDeleteCard(card.entry_id)} title="Remove from collection">""",
    """<button type="button" onClick={() => onDeleteCard(card.entry_id)} title="Remove from container">"""
)

# Wait, there's also the Unsorted column which directly calls handleDeleteCard.
# I replaced `onClick={() => handleDeleteCard(activeCard.entry_id)}` which matches Coverflow.
# But in Unsorted, it's `onClick={() => handleDeleteCard(card.entry_id)}`.
# I should NOT replace that one, because in Unsorted, they DO want to delete from the collection.
# Let's verify I only replaced the activeCard one.
# Coverflow uses `activeCard.entry_id`, Unsorted uses `card.entry_id`.
# The replacement I did above: "onClick={() => handleDeleteCard(activeCard.entry_id)}" -> This is for Coverflow.
# The replacement "onDeleteCard={handleDeleteCard}" -> This is for BinderPageContent.

# Now check if there is any other `handleDeleteCard` passed.
# In CompartmentCard, it's `onDeleteCard={handleDeleteCard}` which I just replaced, and `CompartmentCard` uses `onDeleteCard(card.entry_id)`.
# In Unsorted, the text is exactly: `onClick={() => handleDeleteCard(card.entry_id)}`. This will REMAIN `handleDeleteCard`, which is correct!

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Frontend delete patched.")
