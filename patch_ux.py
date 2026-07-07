import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add id="recommended-spot" to binder pocket and change opacity
target_binder_ghost = """              <div key="rec-ghost" className={`binder-pocket recommended-ghost ${categoryStart ? 'set-start' : ''}`}>
                {card.image_url && <img src={card.image_url} alt={card.name} style={{ opacity: 0.45 }} />}
                <div className="rec-ghost-label">PLACE HERE</div>
                {categoryStart && <div className="set-divider-label" title={cat}>{cat}</div>}
              </div>"""

replacement_binder_ghost = """              <div id="recommended-spot" key="rec-ghost" className={`binder-pocket recommended-ghost ${categoryStart ? 'set-start' : ''}`}>
                {card.image_url && <img src={card.image_url} alt={card.name} style={{ opacity: 0.85 }} />}
                <div className="rec-ghost-label">Slot {i + 1}</div>
                {categoryStart && <div className="set-divider-label" title={cat}>{cat}</div>}
              </div>"""

if target_binder_ghost in content:
    content = content.replace(target_binder_ghost, replacement_binder_ghost)
else:
    print("Warning: Binder ghost target not found!")

# 2. Add id="recommended-spot" to Box Coverflow
target_coverflow_ghost = """                                  <div
                                    key={card.entry_id}
                                    className={`box-coverflow-card ${offset === 0 ? 'active' : ''} ${card.entry_id === focusEntryId ? 'focus-flash' : ''} ${isRecSpot ? 'recommended-ghost' : ''}`}
                                    style={{
                                      transform,
                                      zIndex,
                                      opacity: isRecSpot ? opacity * 0.8 : opacity,
                                      filter
                                    }}
                                    onClick={() => setCoverflowActiveIndex(i)}
                                  >"""

replacement_coverflow_ghost = """                                  <div
                                    id={isRecSpot ? "recommended-spot" : undefined}
                                    key={card.entry_id}
                                    className={`box-coverflow-card ${offset === 0 ? 'active' : ''} ${card.entry_id === focusEntryId ? 'focus-flash' : ''} ${isRecSpot ? 'recommended-ghost' : ''}`}
                                    style={{
                                      transform,
                                      zIndex,
                                      opacity: isRecSpot ? opacity : opacity,
                                      filter
                                    }}
                                    onClick={() => setCoverflowActiveIndex(i)}
                                  >"""

if target_coverflow_ghost in content:
    content = content.replace(target_coverflow_ghost, replacement_coverflow_ghost)
else:
    print("Warning: Coverflow ghost target not found!")

# 2b. Make Coverflow ghost card obvious
target_coverflow_rec_spot = """                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: '#ffc107', color: '#000', fontSize: '0.5rem', fontWeight: 'bold', padding: '1px 4px', borderRadius: '3px', zIndex: 10 }}>REC SPOT</div>
                                  )}"""

replacement_coverflow_rec_spot = """                                  {isRecSpot && (
                                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#ffc107', color: '#000', fontSize: '0.75rem', fontWeight: 'bold', padding: '3px 8px', borderRadius: '4px', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>Slot {i + 1}</div>
                                  )}"""

if target_coverflow_rec_spot in content:
    content = content.replace(target_coverflow_rec_spot, replacement_coverflow_rec_spot)
else:
    print("Warning: Coverflow REC SPOT label not found!")

# 3. Update Sidebar Place Here Box to be clickable and include slot number
target_sidebar = """                    <div style={{ background: 'rgba(255, 193, 7, 0.15)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.7rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', marginBottom: '0.25rem' }}>Place Here</div>
                      <strong style={{ fontSize: '0.9rem', color: '#fff' }}>{targetLocName} &rarr; {targetCompName}</strong>
                    </div>"""

replacement_sidebar = """                    <div 
                      style={{ background: 'rgba(255, 193, 7, 0.15)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.25)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.15)'; }}
                      onClick={() => {
                        const el = document.getElementById('recommended-spot');
                        if (el) {
                          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                          el.classList.remove('flash-highlight');
                          void el.offsetWidth;
                          el.classList.add('flash-highlight');
                        }
                      }}
                      title="Click to snap to this slot in the container"
                    >
                      <div style={{ fontSize: '0.7rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', marginBottom: '0.25rem' }}>Click to Locate</div>
                      <strong style={{ fontSize: '0.9rem', color: '#fff', display: 'block' }}>{targetLocName} &rarr; {targetCompName}</strong>
                      <strong style={{ fontSize: '1.2rem', color: '#ffc107', display: 'block', marginTop: '0.25rem' }}>Slot {Math.floor(rec.position / 1000)}</strong>
                    </div>"""

if target_sidebar in content:
    content = content.replace(target_sidebar, replacement_sidebar)
else:
    print("Warning: Sidebar target not found!")

with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("LocationManager.jsx patched.")
