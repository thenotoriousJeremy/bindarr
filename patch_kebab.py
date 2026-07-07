import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleAddCompartment(); }}>
                    <Plus size={14} /> {isBinderType ? 'Add Page' : 'Add Compartment'}
                  </button>"""

replacement = """                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleAddCompartment(); }}>
                    <Plus size={14} /> {isBinderType ? 'Add Page' : 'Add Compartment'}
                  </button>
                  <button className="kebab-item" 
                          disabled={compartments.length <= 1 || (cardsByCompartment.get(compartments[compartments.length-1]?.id) || []).length > 0} 
                          onClick={() => { setShowKebabMenu(false); handleRemoveCompartment(compartments[compartments.length-1].id); }}
                          title="Only the last empty row/page can be removed"
                  >
                    <Trash2 size={14} /> {isBinderType ? 'Remove Last Page' : 'Remove Last Compartment'}
                  </button>"""

if target in content:
    content = content.replace(target, replacement)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Frontend kebab menu patched.")
else:
    print("Frontend target not found.")
