import { useState } from 'react';
import { useLongPress } from './useLongPress';

// Long-press-to-arm multi-select + bulk actions over collection entries. Shared
// by CollectionList and the scanner's recent-scans strip so both get the same
// UX and hit the same /api/collection/bulk endpoint. onChanged({ ids, action,
// value }) runs after a successful bulk action; the caller refreshes its own
// data (refetch, or prune a local list). Selection is cleared before onChanged,
// so the acted-on ids are passed along. Optional `guard()` returns a message
// string to block arming/bulk (e.g. a locked container) or a falsy value to
// allow it; the message is shown as a toast.
export function useMultiSelect({ showToast, onChanged, guard } = {}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState('');

  const toggleSelect = (entryId) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); setBulkMoveTarget(''); };

  // Enter select mode and select `entryId`. Exposed so callers that own the
  // long-press elsewhere (CompartmentView) can arm the same state.
  const arm = (entryId) => {
    const blocked = guard && guard();
    if (blocked) { showToast(blocked); return; }
    setSelectMode(true);
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
        showToast(data.message || 'Done.');
        clearSelection();
        onChanged && onChanged({ ids, action, value });
      } else {
        showToast(data.error || 'Bulk action failed.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error performing bulk action.');
    }
  };

  return {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, clearSelection, exitSelectMode, arm,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  };
}
