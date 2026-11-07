import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { cardColor } from '../utils/cardColors';
import { RARITY_STRIP_COLORS, stripColorKey, stripGradient, stripRarityKey, stripRuns, stripTabs } from '../utils/boxStrip';
import { displayName } from '../utils/languages';
import { useT } from '../utils/i18n';

// The whole of a box on one screen: every row as a strip of card colours with
// the rarities under it and a tab at each divider, under the coverflow of the
// row that is open. Tapping or dragging a strip opens that row at that card; the
// open row's strip carries a bracket over what the coverflow is showing.

const EMPTY = [];
// Empty slots are hatched under the colour lane, so free space shows at a glance.
const HATCH = 'repeating-linear-gradient(135deg, var(--border-glass-hover) 0 1px, transparent 1px 4px)';
// The coverflow shows this many cards clearly either side of the centred one;
// the bracket spans the same stretch of the strip.
const VIEW_SPAN = 4;
// Roughly how wide a tab is at its font size, capped where the label ellipsizes.
// Used to decide which tabs have room for a label; the rest are ticks.
const tabWidth = (label) => Math.min(String(label).length * 6 + 12, 120);

function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function RowStrip({ compartment, cards, sortOrder, setsList, active, activeSlot, recommendedIndex, onSeek }) {
  const { t } = useT();
  const sliderRef = useRef(null);
  const width = useElementWidth(sliderRef);

  const total = Math.max(compartment.capacity || 1, cards.length);
  const lastFilled = cards.length - 1;
  const slots = useMemo(() => Array.from({ length: total }, (_, i) => cards[i] || null), [cards, total]);
  const laneBackground = useMemo(
    () => stripGradient(stripRuns(slots, stripColorKey), total, key => (key ? cardColor(key) : null)),
    [slots, total]
  );
  const rarityBackground = useMemo(
    () => stripGradient(stripRuns(slots, stripRarityKey), total, key => RARITY_STRIP_COLORS[key] || null),
    [slots, total]
  );
  const tabs = useMemo(() => stripTabs(slots, sortOrder, setsList), [slots, sortOrder, setsList]);
  // Top-level tabs get a label where there is room for one, left to right; the
  // last is pulled back inside the strip rather than hanging off its end.
  const labelled = useMemo(() => {
    if (!width) return EMPTY;
    const placed = [];
    let lastRight = -Infinity;
    tabs.forEach(tab => {
      if (tab.depth > 0) return;
      const w = tabWidth(tab.label);
      const left = Math.min(tab.index / total * width, width - w);
      if (left < lastRight + 3) return;
      placed.push({ ...tab, left });
      lastRight = left + w;
    });
    return placed;
  }, [tabs, total, width]);

  // Dragging asks for at most one seek per frame: each one re-renders the
  // coverflow, and a pointer reports far more often than that.
  const dragging = useRef(false);
  const frame = useRef(0);
  const pendingSlot = useRef(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const slotAt = (clientX) => {
    const rect = sliderRef.current.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(total - 1, Math.floor((clientX - rect.left) / rect.width * total)));
  };
  const seekSoon = (slot) => {
    pendingSlot.current = slot;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      onSeek(compartment.id, pendingSlot.current);
    });
  };

  const current = active && activeSlot != null ? activeSlot : 0;
  const onKeyDown = (e) => {
    let next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) {
        // Tab to tab, the way Ctrl+arrow moves word to word.
        const starts = tabs.filter(tab => tab.depth === 0).map(tab => tab.index);
        next = dir > 0 ? starts.find(i => i > current) : starts.filter(i => i < current).pop();
        if (next === undefined) return;
      } else {
        next = Math.max(0, Math.min(Math.max(0, lastFilled), current + dir));
      }
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = Math.max(0, lastFilled);
    } else {
      return;
    }
    e.preventDefault();
    onSeek(compartment.id, next, { divider: e.shiftKey });
  };

  const currentCard = slots[current];
  const valueText = currentCard
    ? t('loc.boxMapSlot', { slot: current + 1, name: displayName(currentCard) })
    : t('loc.boxMapEmptySlot', { slot: current + 1 });
  const pct = (n) => `${n / total * 100}%`;
  const viewFrom = Math.max(0, current - VIEW_SPAN);
  const viewTo = Math.min(total, current + VIEW_SPAN + 1);

  return (
    <div className="box-map-row">
      <div className={`box-map-head ${active ? 'active' : ''}`}>
        <span className="box-map-label">{compartment.display_label}</span>
        {!!compartment.locked && <Lock size={10} aria-hidden="true" />}
        <span className="box-map-count">{compartment.count ?? cards.length} / {compartment.capacity}</span>
      </div>
      <div className="box-map-strip">
        {labelled.map(tab => (
          <button
            key={`tab-${tab.index}`}
            type="button"
            className="box-map-tab"
            style={{ left: tab.left, background: tab.color }}
            title={t('loc.boxMapTab', { label: tab.label, start: tab.index + 1, end: tab.end, count: tab.count })}
            onClick={() => onSeek(compartment.id, tab.index, { divider: true })}
          >
            {tab.label}
          </button>
        ))}
        {tabs.map(tab => (
          <span key={`tick-${tab.index}`} className={`box-map-tick ${tab.depth > 0 ? 'minor' : ''}`} style={{ left: pct(tab.index) }} />
        ))}
        <div
          ref={sliderRef}
          className="box-map-slider"
          role="slider"
          tabIndex={0}
          aria-label={t('loc.boxMapPosition', { row: compartment.display_label })}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={current + 1}
          aria-valuetext={valueText}
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragging.current = true;
            // Keeps the drag when the pointer strays off the strip. Throws if the
            // pointer has already gone, which must not cost the seek below.
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* drag without capture */ }
            // A finger may only be on its way to scrolling the page; it seeks
            // once it moves along the strip or lifts, not the moment it lands.
            if (e.pointerType !== 'touch') {
              e.currentTarget.focus({ preventScroll: true });
              seekSoon(slotAt(e.clientX));
            }
          }}
          onPointerMove={(e) => { if (dragging.current) seekSoon(slotAt(e.clientX)); }}
          onPointerUp={(e) => {
            if (dragging.current) seekSoon(slotAt(e.clientX));
            dragging.current = false;
          }}
          onPointerCancel={() => { dragging.current = false; }}
          onKeyDown={onKeyDown}
        >
          <div className="box-map-lane" style={{ background: `${laneBackground}, ${HATCH}` }} />
          <div className="box-map-rarity" style={{ background: rarityBackground }} />
          {active && activeSlot != null && (
            <div className="box-map-window" style={{ left: pct(viewFrom), width: `max(6px, ${pct(viewTo - viewFrom)})` }} />
          )}
          {recommendedIndex != null && recommendedIndex >= 0 && (
            <div className="box-map-rec" style={{ left: pct(Math.min(recommendedIndex, total - 1) + 0.5) }} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function BoxMap({
  compartments,
  cardsByCompartment,
  sortOrder,
  setsList = [],
  activeCompartmentId,
  // 0-based slot the open row's coverflow is centred on, or null before it says.
  activeSlot = null,
  // { compartmentId, index } of the filing walkthrough's recommended slot.
  recommended = null,
  // onSeek(compartmentId, slot, { divider }) opens a row at a slot.
  onSeek,
}) {
  const { t } = useT();
  if (!compartments || compartments.length === 0) return null;
  return (
    <div className="box-map" role="group" aria-label={t('loc.boxMap')}>
      {compartments.map(c => (
        <RowStrip
          key={c.id}
          compartment={c}
          cards={cardsByCompartment.get(c.id) || EMPTY}
          sortOrder={sortOrder}
          setsList={setsList}
          active={c.id === activeCompartmentId}
          activeSlot={c.id === activeCompartmentId ? activeSlot : null}
          recommendedIndex={recommended && recommended.compartmentId === c.id ? recommended.index : null}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}
