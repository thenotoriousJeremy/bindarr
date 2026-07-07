import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("activeComp.assignedFilters.length === 0 ? 'Any set' : activeComp.assignedFilters.length === 1 ? activeComp.assignedFilters[0] : `${activeComp.assignedFilters.length} sets`", "activeComp.assignedFilters.length === 0 ? 'Any category' : activeComp.assignedFilters.length === 1 ? activeComp.assignedFilters[0] : `${activeComp.assignedFilters.length} cats`")
content = content.replace("Choose set to toggle...", "Choose category to toggle...")
content = content.replace("availableSetNames.map(setName", "availableCategories.map(filterVal")
content = content.replace("activeComp.assignedFilters.includes(setName)", "activeComp.assignedFilters.includes(filterVal)")
content = content.replace("? `✓ ${setName}` : setName", "? `✓ ${filterVal}` : filterVal")
content = content.replace("activeComp.assignedFilters.map(setName", "activeComp.assignedFilters.map(filterVal")
content = content.replace("{setName}", "{filterVal}")
content = content.replace("key={setName}", "key={filterVal}")
content = content.replace("value={setName}", "value={filterVal}")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Fixed remaining sets UI text in LocationManager.jsx")
