import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Update getSortCategory signature and logic
content = content.replace(
    "function getSortCategory(card, sortOrder) {",
    "function getSortCategory(card, sortOrder, setsList = []) {"
)

content = content.replace(
    """  if (sortOrder.startsWith('set')) return card.set_name || 'Unknown Set';""",
    """  if (sortOrder.startsWith('set')) {
    if (!card.set_name) return 'Unknown Set';
    if (!setsList || setsList.length === 0) return card.set_name;
    const idx = setsList.findIndex(s => s.name === card.set_name);
    return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
  }"""
)

# Add setsList state and fetch
if "const [setsList, setSetsList] = useState([]);" not in content:
    content = content.replace(
        "const [refreshFilingId, setRefreshFilingId] = useState(0);",
        """const [refreshFilingId, setRefreshFilingId] = useState(0);
  const [setsList, setSetsList] = useState([]);

  useEffect(() => {
    fetch('/api/sets')
      .then(res => res.json())
      .then(data => setSetsList(data))
      .catch(err => console.error(err));
  }, []);"""
    )

# Update getSortCategory calls in CompartmentCard and BinderPageContent
# Note: they both receive `availableSets` but we need the global `setsList` instead, 
# or we can pass `setsList` as a prop into CompartmentCard and BinderPageContent.
# Actually, we can just pass setsList into those components from LocationManager!

# But wait! CompartmentCard doesn't have access to setsList. We need to pass it as a prop.
# Let's pass setsList down.

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated LocationManager.jsx")
