import sys
import re

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target = """      {cards.length === 0 ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.25rem 0' }}>Empty</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {cards.map(card => (
            <div key={card.entry_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', padding: '0.25rem 0', borderBottom: '1px solid var(--border-glass)' }}>
              <div style={{ position: 'relative', width: '32px', flexShrink: 0, overflow: 'hidden', borderRadius: '3px', ...getCardRarityBorder(card.rarity) }}>
                <img src={card.image_url} alt={card.name} style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                {getFoilOverlayClass(card.printing) && (
                  <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '3px' }} />
                )}
                <PrintingBadge printing={card.printing} />
              </div>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {card.name}
              </span>
              {isCustom && moveTargets.length > 1 && (
                <select
                  className="select-control"
                  value=""
                  onChange={(e) => { if (e.target.value) onMoveCard(card.entry_id, parseInt(e.target.value, 10)); }}
                  style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', maxWidth: '110px' }}
                >
                  <option value="">Move to...</option>
                  {moveTargets.filter(t => t.id !== compartment.id).map(t => (
                    <option key={t.id} value={t.id}>{t.display_label}</option>
                  ))}
                </select>
              )}
              <button type="button" onClick={() => onDeleteCard(card.entry_id)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }} title="Remove from collection">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}"""

replacement = """      {cards.length === 0 ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.25rem 0' }}>Empty</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {cards.map((card, i) => {
            const prev = i > 0 ? cards[i - 1] : null;
            const cat = getSortCategory(card, sortOrder);
            const prevCat = getSortCategory(prev, sortOrder);
            const categoryStart = cat && (!prev || prevCat !== cat);
            
            return (
              <React.Fragment key={card.entry_id}>
                {categoryStart && (
                  <div style={{ padding: '0.25rem 0.5rem', marginTop: i > 0 ? '0.5rem' : 0, background: 'var(--bg-card)', borderLeft: '3px solid var(--accent-red)', fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-primary)', borderRadius: '0 4px 4px 0' }}>
                    {cat}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', padding: '0.25rem 0', borderBottom: '1px solid var(--border-glass)' }}>
                  <div style={{ position: 'relative', width: '32px', flexShrink: 0, overflow: 'hidden', borderRadius: '3px', ...getCardRarityBorder(card.rarity) }}>
                    <img src={card.image_url} alt={card.name} style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                    {getFoilOverlayClass(card.printing) && (
                      <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '3px' }} />
                    )}
                    <PrintingBadge printing={card.printing} />
                  </div>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {card.name}
                  </span>
                  {isCustom && moveTargets.length > 1 && (
                    <select
                      className="select-control"
                      value=""
                      onChange={(e) => { if (e.target.value) onMoveCard(card.entry_id, parseInt(e.target.value, 10)); }}
                      style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', maxWidth: '110px' }}
                    >
                      <option value="">Move to...</option>
                      {moveTargets.filter(t => t.id !== compartment.id).map(t => (
                        <option key={t.id} value={t.id}>{t.display_label}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" onClick={() => onDeleteCard(card.entry_id)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }} title="Remove from collection">
                    <X size={14} />
                  </button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}"""

if target in content:
    content = content.replace(target, replacement)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("CompartmentCard dividers added.")
else:
    print("Warning: CompartmentCard target not found")
