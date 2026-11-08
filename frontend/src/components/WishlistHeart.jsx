import { useState } from 'react';
import { Heart } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useWishlist } from '../utils/useWishlist';

// The heart on a card: on the default Wishlist or not, one tap to switch. The
// list is made on the first tap (utils/wishlist.js), so it works with no setup.
// Sits inside clickable card tiles, so its clicks and keys stop here and never
// open the card underneath. `variant` 'overlay' floats over a card image, in
// its top or bottom right `corner`; 'button' is a labelled .btn (the inspector).
export default function WishlistHeart({ card, showToast, variant = 'overlay', corner = 'top', size = 15 }) {
  const { t } = useT();
  const store = useWishlist();
  if (!card || !card.id) return null;
  const on = store.has(card.id);
  const name = card.name || '';

  const toggle = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (on) {
      const ok = await store.remove(card.id);
      if (showToast) showToast(ok ? t('wishlist.removed', { name }) : t('wishlist.errUpdate'));
      return;
    }
    const { added, already, error } = await store.add([card.id]);
    if (!showToast) return;
    if (added || already) showToast(t('wishlist.added', { name }));
    else showToast(error || t('wishlist.errUpdate'));
  };
  const label = t(on ? 'wishlist.removeOne' : 'wishlist.addOne');

  if (variant === 'button') {
    return (
      <button
        type="button"
        className={`btn ${on ? 'btn-primary' : 'btn-secondary'}`}
        onClick={toggle}
        aria-pressed={on}
        title={label}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <Heart size={size} fill={on ? 'currentColor' : 'none'} />
        {t(on ? 'wishlist.onWishlist' : 'wishlist.want')}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`wish-heart${corner === 'bottom' ? ' wish-heart-bottom' : ''}${on ? ' on' : ''}`}
      onClick={toggle}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={on}
      aria-label={label}
      title={label}
    >
      <Heart size={size} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

// "Add selected to Wishlist" for the bulk bars. `cardIds` may be a function,
// read when pressed (a selection changes after render), like AddToListSelect.
export function AddSelectedToWishlist({ cardIds, showToast, disabled = false, onDone, style }) {
  const { t } = useT();
  const store = useWishlist();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const ids = typeof cardIds === 'function' ? cardIds() : cardIds;
    if (!ids || ids.length === 0) return;
    setBusy(true);
    try {
      const { added, already, failed, error } = await store.add(ids);
      if (showToast) {
        if (added > 0 && failed.length) showToast(t('wishlist.addedSomeFailed', { count: added, failed: failed.length }));
        else if (added > 0) showToast(t('wishlist.addedMany', { count: added }));
        else if (already > 0) showToast(t('wishlist.alreadyAll'));
        else showToast(error || t('wishlist.errUpdate'));
      }
      if (onDone && (added || already)) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={disabled || busy}
      onClick={run}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', ...style }}
    >
      <Heart size={13} fill="currentColor" />
      {t('wishlist.addSelected')}
    </button>
  );
}
