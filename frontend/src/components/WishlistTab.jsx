import { useState, useEffect, useRef } from 'react';
import ListDetail, { WishlistStartHint } from './ListDetail';
import { useT } from '../utils/i18n';
import { LatestRequest, fetchJson, isAbortError } from '../utils/request';

// Collection > Cards > Wishlist: the default Wishlist, the one list the hearts on
// cards fill and the only wishlist there is (the collection kept a second one
// until WEB-03; utils/wishlistMigration.js on the server moved it here). Shown
// with the Lists view's own detail, so it is edited the same way in both places.
// Until the first heart there is no list, and this says how to start one.
export default function WishlistTab({ active = true, statsTrigger, showToast }) {
  const { t } = useT();
  const [listId, setListId] = useState(undefined);   // undefined: not read yet; null: none
  const req = useRef(null);
  if (!req.current) req.current = new LatestRequest();
  useEffect(() => () => req.current.cancel(), []);

  const load = async () => {
    const mine = req.current.begin();
    try {
      const { data } = await fetchJson('/api/lists/default', { signal: mine.signal });
      if (mine.isLatest()) setListId(data && data.list ? data.list.id : null);
    } catch (err) {
      if (isAbortError(err) || !mine.isLatest()) return;
      console.error(err);
      showToast(t('lists.errLoad'));
      setListId(null);
    }
  };

  useEffect(() => {
    if (active) load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast/t change identity every App render; refetch only on these
  }, [active, statsTrigger]);

  if (listId === undefined) return <div className="spinner" />;
  if (listId === null) return <WishlistStartHint />;
  return (
    <ListDetail
      key={listId}
      listId={listId}
      active={active}
      statsTrigger={statsTrigger}
      showToast={showToast}
      onGone={load}
      onDeleted={load}
    />
  );
}
