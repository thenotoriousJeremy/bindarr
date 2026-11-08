import { useRef, useState } from 'react';
import { useLongPress } from './useLongPress';
import { useT } from './i18n';
import { undoFor, undoToast } from './undo';
import { apiErrorText } from './apiError';

// Long-press-to-arm multi-select + bulk actions over collection entries. Shared
// by CollectionList and the scanner's recent-scans strip so both get the same
// UX and hit the same /api/collection/bulk endpoint. onChanged({ ids, action,
// value }) runs after a successful bulk action; the caller refreshes its own
// data (refetch, or prune a local list). Selection is cleared before onChanged,
// so the acted-on ids are passed along. Optional `guard()` returns a message
// string to block arming/bulk (e.g. a locked container) or a falsy value to
// allow it; the message is shown as a toast. A delete or a move to Unsorted
// carries an Undo button; undoing runs onChanged again with action 'undo'.
export function useMultiSelect({ showToast, onChanged, guard } = {}) {
  const { t } = useT();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState('');

  // Last plainly-clicked id: the far end of a shift-click range.
  const anchorId = useRef(null);

  const toggleSelect = (entryId) => {
    anchorId.current = entryId;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };

  // Click-to-toggle with shift-click range, over `orderedIds` as currently
  // displayed — so a range is exactly what sits between the two cards on
  // screen, whatever sort or filter is active. Shift only ever extends, so
  // several shift-clicks build a selection out of separate blocks.
  const selectAt = (entryId, orderedIds, withShift) => {
    const anchor = anchorId.current;
    if (!withShift || anchor == null || anchor === entryId) {
      toggleSelect(entryId);
      return;
    }
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(entryId);
    if (from === -1 || to === -1) { toggleSelect(entryId); return; }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return next;
    });
  };

  const clearSelection = () => { anchorId.current = null; setSelectedIds(new Set()); };
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); setBulkMoveTarget(''); };

  // Enter select mode and select `entryId`. Exposed so callers that own the
  // long-press elsewhere (CompartmentView) can arm the same state.
  const arm = (entryId) => {
    const blocked = guard && guard();
    if (blocked) { showToast(blocked); return; }
    setSelectMode(true);
    anchorId.current = entryId;
    setSelectedIds(prev => new Set(prev).add(entryId));
  };

  // Long-press arms select mode and selects the held card (shared gesture).
  const { handlers: pressHandlers, fired: longPressFired } = useLongPress(arm);

  // Runs one bulk action against every selected entry via the bulk endpoint.
  const runBulk = async (action, value, confirmMsg) => {
    const blocked = guard && guard();
    if (blocked) { showToast(blocked); return; }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { showToast('No cards selected.'); return; }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids, action, value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const undo = undoFor(action, value, data);
        showToast(data.message || t('bulk.done'), undoToast(undo, {
          showToast, t, onDone: () => onChanged && onChanged({ ids, action: 'undo', value: null })
        }));
        clearSelection();
        onChanged && onChanged({ ids, action, value });
      } else {
        showToast(apiErrorText(t, data, 'bulk.errAction'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('bulk.errActionGeneric'));
    }
  };

  return {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode, arm,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  };
}
