import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

old_move = """  const handleMoveCard = async (entryId, compartmentId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compartment_id: compartmentId })
      });
      if (res.ok) { showToast('Card moved.'); await refreshAll(); }
      else showToast('Failed to move card.');
    } catch (err) { console.error(err); showToast('Error moving card.'); }
  };"""

new_move = """  const handleMoveCard = async (entryId, compartmentId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compartment_id: compartmentId })
      });
      if (res.ok) { showToast('Card moved.'); await refreshAll(); }
      else {
        const errData = await res.json().catch(()=>({}));
        showToast(errData.error || 'Failed to move card.');
      }
    } catch (err) { console.error(err); showToast('Error moving card.'); }
  };"""

if old_move in content:
    content = content.replace(old_move, new_move)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Frontend patched.")
else:
    print("Frontend old string not found.")
