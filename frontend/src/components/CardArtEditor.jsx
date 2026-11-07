import { useRef, useState } from 'react';
import { ImagePlus, Upload, Trash2, Share2 } from 'lucide-react';
import { artUrl, noteArtChanged, useCardArtIndex } from '../utils/cardArt';
import { issueUrl } from '../utils/repo';
import { useT } from '../utils/i18n';

// INCOMPLETE — not mounted anywhere, and not ready to be.
//
// ponytail: unfinished feature, no call site. To finish it: add the fourteen art.*
// keys to frontend/src/locales/en.json (art.add, art.replace, art.remove,
// art.contribute, art.saved, art.removed, art.tooLarge, art.notAnImage,
// art.saveFailed, art.removeFailed, art.shareFailed, art.issueIntro,
// art.issueAttach, art.issueRights), then render this in CardInspectorModal's
// image column where the comment marks the spot.
//
// Why it is not mounted: NONE of those keys exist in any locale file, and
// translate() falls back to the key itself (see utils/translate.js) — so every
// control here renders its own key as its label: a button reading "art.add".
// CHANGELOG 1.7.0 lists "per-card art overrides" as shipped, which is true of the
// backend (POST/DELETE /api/card-art) and of DISPLAY (CardImage prefers
// contributed art over provider art everywhere, inspector included). It is the
// upload UI that never landed.
//
// Everything else here is done and was checked against the live endpoints: the
// global fetch interceptor in App.jsx supplies the Bearer token, so the POST and
// DELETE authenticate without this component doing anything.
//
// The controls under the inspector's card image for supplying art the upstream
// APIs do not have, and for passing that art back so everyone else gets it too.
//
// Two separate acts, deliberately. Uploading fixes the gap on THIS instance
// immediately and offline. Contributing is a second, explicit press that hands
// the user the file plus a prefilled issue — Bindarr never uploads anything
// anywhere on its own, and the user submits (or does not) on GitHub.

const MAX_BYTES = 8 * 1024 * 1024; // matches backend/src/cardArt.js

const btn = { fontSize: '0.7rem', padding: '0.3rem 0.6rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };

// Uploading and removing art is admin-only on the backend (the art is shown to
// every user on the instance), so members never get a button that can only 403.
// Read from the session App.jsx persists rather than threading `user` through
// every CardInspectorModal call site; App rewrites it on login and profile edits.
function isAdmin() {
  try {
    return JSON.parse(localStorage.getItem('bindarr_user') || 'null')?.role === 'admin';
  } catch {
    return false;
  }
}

export default function CardArtEditor({ card, hasProviderArt, showToast, onChanged }) {
  const { t } = useT();
  const index = useCardArtIndex();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const cardId = card?.card_id || card?.id;
  if (!cardId) return null;

  const hasCustom = index.has(cardId);
  const canEdit = isAdmin();
  // Contributing only downloads the public art and opens an issue, so members
  // keep it; with nothing to contribute and no edit rights there is nothing to show.
  if (!canEdit && !hasCustom) return null;

  const pick = () => fileRef.current?.click();

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so re-picking the same file fires change again
    if (!file) return;
    if (!file.type.startsWith('image/')) return showToast?.(t('art.notAnImage'));
    if (file.size > MAX_BYTES) return showToast?.(t('art.tooLarge'));

    setBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(file);
      });
      const res = await fetch(`/api/card-art/${encodeURIComponent(cardId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'upload failed');
      noteArtChanged(cardId, true);
      onChanged?.();
      showToast?.(t('art.saved'));
    } catch (err) {
      showToast?.(t('art.saveFailed', { message: err.message }));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/card-art/${encodeURIComponent(cardId)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'delete failed');
      // The card may still have art after this: deleting only drops this
      // instance's copy, and art contributed upstream lives in the image.
      noteArtChanged(cardId, !!data.hasBundled);
      onChanged?.();
      showToast?.(t('art.removed'));
    } catch (err) {
      showToast?.(t('art.removeFailed', { message: err.message }));
    } finally {
      setBusy(false);
    }
  };

  // Hand over the normalized PNG the server produced (not the user's original —
  // that is what would be committed) and open the issue form beside it.
  const onContribute = async () => {
    setBusy(true);
    try {
      const blob = await fetch(artUrl(cardId)).then(r => {
        if (!r.ok) throw new Error('art not found');
        return r.blob();
      });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${cardId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);

      const body = [
        t('art.issueIntro'),
        '',
        `- **Card id**: \`${cardId}\``,
        `- **Name**: ${card.name || ''}`,
        `- **Set**: ${card.set_name || ''} (${card.set_id || '?'})`,
        `- **Number**: ${card.number || ''}`,
        `- **Game**: ${card.game || ''}`,
        `- **Language**: ${card.language || ''}`,
        '',
        t('art.issueAttach', { file: `${cardId}.png` }),
        '',
        t('art.issueRights'),
      ].join('\n');

      window.open(issueUrl({
        labels: 'card-art',
        title: `[Card art] ${card.name || cardId}`,
        body,
      }), '_blank', 'noopener');
    } catch (err) {
      showToast?.(t('art.shareFailed', { message: err.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', justifyContent: 'center', marginTop: '0.6rem' }}>
      {canEdit && (
        <>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />

          <button className="btn btn-secondary" style={btn} onClick={pick} disabled={busy}>
            {hasCustom || hasProviderArt ? <Upload size={13} /> : <ImagePlus size={13} />}
            {/* "Add" when the slot is showing a card back, "Replace" when there is
                already art to look at — the same button, but the two cases read very
                differently to somebody staring at a blank back. */}
            {hasCustom || hasProviderArt ? t('art.replace') : t('art.add')}
          </button>
        </>
      )}

      {hasCustom && (
        <>
          <button className="btn btn-secondary" style={btn} onClick={onContribute} disabled={busy}>
            <Share2 size={13} />
            {t('art.contribute')}
          </button>
          {canEdit && (
            <button className="btn btn-secondary" style={{ ...btn, color: 'var(--accent-red)' }} onClick={onRemove} disabled={busy}>
              <Trash2 size={13} />
              {t('art.remove')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
