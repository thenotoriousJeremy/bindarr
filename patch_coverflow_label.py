import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                                  {categoryStart && (
                                    <div style={{ position: 'absolute', top: '-24px', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-card)', border: '1px solid var(--border-glass)', borderBottom: 'none', padding: '2px 10px', borderRadius: '6px 6px 0 0', fontSize: '0.65rem', fontWeight: 'bold', whiteSpace: 'nowrap', zIndex: -1 }}>
                                      {cat}
                                    </div>
                                  )}"""

replacement = """                                  {categoryStart && (
                                    <div className="set-divider-label" title={cat}>
                                      {cat}
                                    </div>
                                  )}"""

if target in content:
    content = content.replace(target, replacement)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Coverflow divider patched.")
else:
    print("Warning: target not found")
