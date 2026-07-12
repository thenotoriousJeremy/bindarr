import { useState, useMemo, useEffect } from 'react';
import { X, Check, Minus, MapPin, Package, AlertTriangle } from 'lucide-react';
import CompartmentView from './CompartmentView';
import { sortCardsByOrder } from '../utils/cardSort';

// Slot number a stored position encodes (positions are slot * 1000).
const slotOf = (position) => (position ? Math.floor(position / 1000) : null);

const COPY = {
  checkout: {
    title: 'Deck Checked Out',
    subtitle: 'Grab these cards from your collection.',
    verb: 'pulled'
  },
  checkin: {
    title: 'Return to Storage',
    subtitle: 'Put these cards back where they belong.',
    verb: 'returned'
  }
};

// Post-checkout / return locator. A "where does each card go" checklist backed
// by the locations payload the backend computed. Never mutates the collection
// (checkout no longer unassigns, so a card's stored slot is both where you grab
// it and where it returns). Located pages render their compartment layout with
// the cards highlighted by entry_id. Select-all works per page, per container,
// and globally.
const CheckoutWizardModal = ({ locationsData, mode = 'checkout', onClose }) => {
  const copy = COPY[mode] || COPY.checkout;
  const [done, setDone] = useState(new Set());
  const [setsList, setSetsList] = useState([]);
  const [grids, setGrids] = useState({}); // page.key -> { compartment, cards, locationType, sortOrder }

  // Flatten to pulls, then build container -> page tree plus a flat page list.
  const { containers, pagesFlat, missing, totalPulls, allEntryIds } = useMemo(() => {
    const pulls = [];
    const missing = [];
    for (const card of locationsData || []) {
      for (const loc of card.locations || []) pulls.push({ ...loc, card_id: card.card_id });
      if (card.missing > 0) {
        const name = card.locations?.[0]?.card_name || card.card_id;
        missing.push({ card_id: card.card_id, name, qty: card.missing });
      }
    }

    const containerMap = new Map();
    for (const p of pulls) {
      const cKey = p.location_id ? `loc-${p.location_id}` : 'unassigned';
      if (!containerMap.has(cKey)) {
        containerMap.set(cKey, {
          key: cKey,
          unassigned: !p.location_id,
          location_name: p.location_name || 'Unassigned Pile',
          pageMap: new Map()
        });
      }
      const c = containerMap.get(cKey);
      const pKey = p.location_id ? `${p.location_id}-${p.compartment_id}` : 'unassigned';
      if (!c.pageMap.has(pKey)) {
        c.pageMap.set(pKey, {
          key: pKey,
          location_id: p.location_id || null,
          compartment_id: p.compartment_id || null,
          compartment_display: p.compartment_display,
          pulls: []
        });
      }
      c.pageMap.get(pKey).pulls.push(p);
    }

    const containers = Array.from(containerMap.values()).map(c => {
      const pages = Array.from(c.pageMap.values()).sort((a, b) => (a.compartment_id || 0) - (b.compartment_id || 0));
      for (const pg of pages) pg.pulls.sort((x, y) => (x.position || 0) - (y.position || 0));
      return {
        key: c.key,
        unassigned: c.unassigned,
        location_name: c.location_name,
        pages,
        entryIds: pages.flatMap(pg => pg.pulls.map(p => p.entry_id))
      };
    });
    containers.sort((a, b) => {
      if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
      return a.location_name.localeCompare(b.location_name);
    });

    const pagesFlat = containers.filter(c => !c.unassigned).flatMap(c => c.pages);
    return { containers, pagesFlat, missing, totalPulls: pulls.length, allEntryIds: pulls.map(p => p.entry_id) };
  }, [locationsData]);

  useEffect(() => {
    fetch('/api/sets').then(r => r.json()).then(setSetsList).catch(() => {});
  }, []);

  // Load each located page's compartment layout so pulled cards can be
  // highlighted in their physical grid (by entry_id, order-independent).
  useEffect(() => {
    let active = true;
    if (pagesFlat.length === 0) { setGrids({}); return; }

    const locCache = new Map();
    const fetchLocation = async (locationId) => {
      if (!locCache.has(locationId)) {
        locCache.set(locationId, Promise.all([
          fetch(`/api/locations/${locationId}`).then(r => r.json()),
          fetch(`/api/locations/${locationId}/compartments`).then(r => r.json())
        ]).then(([loc, comps]) => ({ loc, comps })));
      }
      return locCache.get(locationId);
    };

    (async () => {
      const next = {};
      for (const pg of pagesFlat) {
        try {
          const { loc, comps } = await fetchLocation(pg.location_id);
          const comp = comps.find(c => c.id === pg.compartment_id);
          if (!comp) continue;
          const cards = await fetch(`/api/collection?compartment_id=${pg.compartment_id}`).then(r => r.json());
          const sortOrder = loc.sort_order || 'custom';
          if (sortOrder === 'custom') cards.sort((a, b) => (a.position || 0) - (b.position || 0));
          else sortCardsByOrder(cards, sortOrder, loc.foil_sorting, setsList);
          next[pg.key] = { compartment: comp, cards, locationType: loc.type || 'Binder', sortOrder };
        } catch (err) {
          console.error('Failed to load compartment layout', err);
        }
      }
      if (active) setGrids(next);
    })();

    return () => { active = false; };
  }, [pagesFlat, setsList]);

  const doneCount = done.size;
  const allComplete = totalPulls > 0 && doneCount === totalPulls;
  const pct = totalPulls ? Math.round((doneCount / totalPulls) * 100) : 0;

  const setChecked = (ids, on) => setDone(prev => {
    const next = new Set(prev);
    ids.forEach(id => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const toggleOne = (id) => setChecked([id], !done.has(id));

  const SelectAll = ({ ids, label = 'Select all' }) => {
    const all = ids.length > 0 && ids.every(id => done.has(id));
    const some = !all && ids.some(id => done.has(id));
    return (
      <button
        type="button"
        onClick={() => setChecked(ids, !all)}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem', flexShrink: 0 }}
      >
        <span style={{ width: '16px', height: '16px', borderRadius: '4px', border: all || some ? 'none' : '2px solid var(--text-muted)', background: all ? 'var(--accent-green)' : some ? 'var(--accent-blue)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: all ? '#000' : '#fff' }}>
          {all ? <Check size={11} strokeWidth={3} /> : some ? <Minus size={11} strokeWidth={3} /> : null}
        </span>
        {label}
      </button>
    );
  };

  const renderRows = (pulls) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {pulls.map(pull => {
        const isDone = done.has(pull.entry_id);
        const slot = slotOf(pull.position);
        return (
          <button
            key={pull.entry_id}
            type="button"
            onClick={() => toggleOne(pull.entry_id)}
            style={{
              textAlign: 'left', width: '100%', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.65rem 0.75rem',
              background: isDone ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.03)',
              border: isDone ? '1px solid var(--accent-green)' : '1px solid var(--border-glass)',
              borderRadius: 'var(--radius-sm)', transition: 'background 0.15s, border-color 0.15s'
            }}
          >
            <div style={{
              width: '22px', height: '22px', flexShrink: 0, borderRadius: '50%',
              border: isDone ? 'none' : '2px solid var(--text-muted)',
              background: isDone ? 'var(--accent-green)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              {isDone && <Check size={14} color="#000" strokeWidth={3} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600, textDecoration: isDone ? 'line-through' : 'none', opacity: isDone ? 0.6 : 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {pull.card_name}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {pull.set_name} · #{pull.number}{slot ? ` · Slot ${slot}` : ''}
              </div>
            </div>
            {pull.take > 1 && (
              <span className="badge" style={{ flexShrink: 0, background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}>
                ×{pull.take}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  const renderGrid = (page) => {
    const grid = grids[page.key];
    if (!grid) return null;
    return (
      <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-md)', padding: '0.85rem', marginBottom: '0.6rem', pointerEvents: 'none', overflow: 'hidden' }}>
        <CompartmentView
          compartment={grid.compartment}
          cards={grid.cards}
          locationType={grid.locationType}
          sortOrder={grid.sortOrder}
          setsList={setsList}
          highlightEntryIds={page.pulls.map(p => p.entry_id)}
          focusEntryId={page.pulls[0]?.entry_id}
          hideFocusedCardInfo
        />
      </div>
    );
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        style={{ maxWidth: '640px', width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-glass)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <div>
              <h2 style={{ fontSize: '1.35rem', color: '#fff', fontWeight: 800, margin: '0 0 0.25rem 0' }}>{copy.title}</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.85rem' }}>{copy.subtitle}</p>
            </div>
            <button className="btn btn-secondary btn-icon-only" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          {totalPulls > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{doneCount} of {totalPulls} {copy.verb}</span>
                <SelectAll ids={allEntryIds} label={allComplete ? 'Clear all' : 'Select all'} />
              </div>
              <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: allComplete ? 'var(--accent-green)' : 'var(--accent-blue)', transition: 'width 0.3s ease' }} />
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {totalPulls === 0 && missing.length === 0 && (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '1.5rem 0', fontSize: '0.9rem' }}>No cards to move.</div>
          )}

          {missing.length > 0 && (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-red)', fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                <AlertTriangle size={16} /> Not enough copies owned
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                {missing.map(m => <div key={m.card_id}>{m.qty}× {m.name}</div>)}
              </div>
            </div>
          )}

          {containers.map(container => {
            const singlePage = container.pages.length === 1;
            return (
              <div key={container.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {/* Container header (with container-level select-all) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0, background: container.unassigned ? 'rgba(148,163,184,0.15)' : 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: container.unassigned ? 'var(--text-muted)' : 'var(--accent-blue)' }}>
                    {container.unassigned ? <Package size={16} /> : <MapPin size={16} />}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem' }}>{container.location_name}</div>
                    {singlePage && container.pages[0].compartment_display && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{container.pages[0].compartment_display}</div>
                    )}
                  </div>
                  <SelectAll ids={container.entryIds} />
                </div>

                {/* Single-page container: grid + rows directly under the header */}
                {singlePage ? (
                  <>
                    {!container.unassigned && renderGrid(container.pages[0])}
                    {renderRows(container.pages[0].pulls)}
                  </>
                ) : (
                  // Multi-page container: each page gets its own select-all + grid
                  container.pages.map(page => (
                    <div key={page.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--border-glass)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600 }}>{page.compartment_display || 'Page'}</span>
                        <SelectAll ids={page.pulls.map(p => p.entry_id)} />
                      </div>
                      {renderGrid(page)}
                      {renderRows(page.pulls)}
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-glass)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', flexShrink: 0 }}>
          <button className="btn btn-primary" onClick={onClose}>{allComplete ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
};

export default CheckoutWizardModal;
