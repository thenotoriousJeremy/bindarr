import { useState, useEffect } from 'react';
import { addCardsToList, createList } from '../utils/listsApi';
import { useT } from '../utils/i18n';
import { wishlist } from '../utils/wishlist';

// "Add to list" picker, the list twin of AddToDeckSelect. Owns the list fetch
// and the add, so the inspector and the bulk bars only say which cards.
// `cardIds` may be a function, read at the moment of choosing (a selection
// changes after render). Lists scoped to another game are not offered; the last
// option makes a new list for this game on the spot. The default Wishlist is
// always offered first, even before it exists: choosing it makes it (through
// utils/wishlist.js, so the hearts see the add).
export default function AddToListSelect({
  cardIds,
  game,
  showToast,
  disabled = false,
  className = 'select-control',
  style,
}) {
  const { t } = useT();
  const [lists, setLists] = useState([]);

  const load = () => fetch('/api/lists')
    .then(r => (r.ok ? r.json() : []))
    .then(setLists)
    .catch(() => {});
  useEffect(() => { load(); }, []);

  const choose = async (value) => {
    const ids = typeof cardIds === 'function' ? cardIds() : cardIds;
    if (!ids || ids.length === 0) return;
    const chosen = lists.find(l => String(l.id) === value);
    if (value === '__default' || (chosen && chosen.is_default)) {
      const { added, already, error } = await wishlist.add(ids);
      load();
      if (!showToast) return;
      if (added > 0) showToast(t('wishlist.addedMany', { count: added }));
      else if (already > 0) showToast(t('wishlist.alreadyAll'));
      else showToast(error || t('lists.errAddCard'));
      return;
    }
    let listId = value;
    let listName = chosen?.name;
    if (value === '__new') {
      const name = window.prompt(t('lists.newListPrompt'));
      if (!name || !name.trim()) return;
      const created = await createList(name.trim(), game || null);
      if (!created) { showToast && showToast(t('lists.errCreate')); return; }
      listId = created.id;
      listName = created.name;
      load();
    }
    const { added, error } = await addCardsToList(listId, ids);
    if (!showToast) return;
    if (added === 0) showToast(error || t('lists.errAddCard'));
    else showToast(t('lists.addedToList', { count: added, name: listName }));
  };

  const offered = lists.filter(l => !l.game || !game || l.game === game);
  const hasDefault = lists.some(l => l.is_default);

  return (
    <select
      className={className}
      value=""
      disabled={disabled}
      onFocus={load}
      onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) choose(v); }}
      style={style}
      aria-label={t('lists.addToList')}
    >
      <option value="">{t('lists.addToList')}</option>
      {!hasDefault && <option value="__default">{t('wishlist.defaultName')}</option>}
      {offered.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      <option value="__new">{t('lists.newListOption')}</option>
    </select>
  );
}
