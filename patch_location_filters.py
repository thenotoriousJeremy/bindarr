import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. availableSetNames -> availableCategories
target1 = """  const availableSetNames = useMemo(() =>
    Array.from(new Set(allCards.map(c => c.set_name).filter(Boolean))).sort(),
  [allCards]);"""
replacement1 = """  const availableCategories = useMemo(() => {
    const cats = new Set();
    allCards.forEach(c => {
      const cat = getSortCategory(c, selectedLoc?.sort_order, setsList);
      if (cat) cats.add(cat);
    });
    return Array.from(cats).sort();
  }, [allCards, selectedLoc?.sort_order, setsList]);"""

content = content.replace(target1, replacement1)
content = content.replace("availableSetNames", "availableCategories")

# 2. availableSets -> availableFilters in component props
content = content.replace(
    "function CompartmentCard({ compartment, cards, sortOrder, availableSets, setsList = [], onRename, onSetCapacity, onToggleSet, onRemove, onDeleteCard, onMoveCard, moveTargets, canRemove }) {",
    "function CompartmentCard({ compartment, cards, sortOrder, availableFilters, setsList = [], onRename, onSetCapacity, onToggleFilter, onRemove, onDeleteCard, onMoveCard, moveTargets, canRemove }) {"
)
content = content.replace(
    "function BinderPageContent({ compartment, cards, sortOrder, availableSets, setsList = [], onRename, onSetCapacity, onToggleSet, onRemove, onDeleteCard, onMoveCard, moveTargets, canRemove, recommendedSpot, focusEntryId }) {",
    "function BinderPageContent({ compartment, cards, sortOrder, availableFilters, setsList = [], onRename, onSetCapacity, onToggleFilter, onRemove, onDeleteCard, onMoveCard, moveTargets, canRemove, recommendedSpot, focusEntryId }) {"
)

# 3. Rename usages in CompartmentCard and BinderPageContent
content = content.replace("availableSets: availableCategories,", "availableFilters: availableCategories,")

# For the dropdowns in CompartmentCard
target_cc_dropdown = """          <select
            className="select-control"
            value=""
            onChange={(e) => { if (e.target.value) onToggleSet(e.target.value); }}
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
          >
            <option value="">Choose set to toggle...</option>
            {availableSets.map(setName => (
              <option key={setName} value={setName}>
                {compartment.assignedSets.includes(setName) ? `✓ ${setName}` : setName}
              </option>
            ))}
          </select>
          {compartment.assignedSets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {compartment.assignedSets.map(setName => (
                <span key={setName} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.1rem 0.3rem', background: 'var(--accent-red)', borderRadius: '3px' }}>
                  {setName}
                  <span style={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => onToggleSet(setName)}>&times;</span>
                </span>
              ))}
            </div>
          )}"""

replacement_cc_dropdown = """          <select
            className="select-control"
            value=""
            onChange={(e) => { if (e.target.value) onToggleFilter(e.target.value); }}
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
          >
            <option value="">Choose category to toggle...</option>
            {availableFilters.map(filterVal => (
              <option key={filterVal} value={filterVal}>
                {(compartment.assignedFilters || []).includes(filterVal) ? `✓ ${filterVal}` : filterVal}
              </option>
            ))}
          </select>
          {compartment.assignedFilters && compartment.assignedFilters.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {compartment.assignedFilters.map(filterVal => (
                <span key={filterVal} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.1rem 0.3rem', background: 'var(--accent-red)', borderRadius: '3px' }}>
                  {filterVal}
                  <span style={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => onToggleFilter(filterVal)}>&times;</span>
                </span>
              ))}
            </div>
          )}"""

content = content.replace(target_cc_dropdown, replacement_cc_dropdown)
content = content.replace("compartment.assignedSets.length === 0 ? 'Any set' : compartment.assignedSets.length === 1 ? compartment.assignedSets[0] : `${compartment.assignedSets.length} sets`", "(compartment.assignedFilters || []).length === 0 ? 'Any category' : (compartment.assignedFilters || []).length === 1 ? compartment.assignedFilters[0] : `${compartment.assignedFilters.length} cats`")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated LocationManager.jsx")
