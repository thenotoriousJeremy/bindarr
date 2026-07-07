import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Pass setsList to getSortCategory inside CompartmentCard
content = content.replace(
    "function CompartmentCard({ compartment, cards, sortOrder, availableSets",
    "function CompartmentCard({ compartment, cards, sortOrder, availableSets, setsList = []"
)
content = content.replace("getSortCategory(card, sortOrder)", "getSortCategory(card, sortOrder, setsList)")
content = content.replace("getSortCategory(prev, sortOrder)", "getSortCategory(prev, sortOrder, setsList)")

# Pass setsList to getSortCategory inside BinderPageContent
content = content.replace(
    "function BinderPageContent({ compartment, cards, sortOrder, availableSets",
    "function BinderPageContent({ compartment, cards, sortOrder, availableSets, setsList = []"
)

# In LocationManager itself, update the render functions to pass setsList down
content = content.replace("availableSets: availableSetNames,", "availableSets: availableSetNames, setsList,")

# Also fix the call inside render method for Coverflow
content = content.replace("getSortCategory(card, selectedLoc.sort_order)", "getSortCategory(card, selectedLoc.sort_order, setsList)")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated callers in LocationManager.jsx")
