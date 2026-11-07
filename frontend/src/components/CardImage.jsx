import { useRef, useState } from 'react';
import { cardBackFor } from '../utils/cardBack';
import { artUrl, useCardArtIndex } from '../utils/cardArt';

// Every card image in the app. A drop-in for the plain <img src={card.image_url}>
// this replaced: className, style, loading, draggable and the rest pass straight
// through, so each call site keeps the sizing it already had.
//
// It exists because a missing image_url used to render as the browser's broken
// image icon — a torn page in the middle of an otherwise finished collection
// grid. Now there is always something card-shaped in the slot.
//
// Sources are tried in order, each one falling to the next when it errors:
//
//   1. contributed art  — somebody supplied art for this card, either on this
//                         instance or upstream in the repo. First because it is a
//                         deliberate act: if it exists, it is what was wanted,
//                         including as an override for provider art judged wrong.
//   2. provider art     — Scryfall / pokemontcg.io / TCGdex, the normal case.
//   3. the card back    — drawn locally, so this step cannot itself fail.
//
// Step 3 is why onError chaining is used rather than a plain src: a URL that 404s
// or a CDN that is unreachable has to degrade the same way an absent one does.
export default function CardImage({ card, src, alt, game, ...imgProps }) {
  const index = useCardArtIndex();

  // Collection rows carry the card's own id in card_id (id is the row's), while
  // search results and scan candidates are the card itself.
  const cardId = card?.card_id || card?.id || null;
  // `src` overrides rather than defaults, so passing src={null} explicitly still
  // means "no provider art" instead of falling through to card.image_url.
  const provider = src !== undefined ? src : card?.image_url;
  const back = cardBackFor(game ?? card?.game);

  const chain = [
    cardId && index.has(cardId) ? artUrl(cardId) : null,
    provider || null,
    back,
  ].filter(Boolean);

  const [step, setStep] = useState(0);

  // Reset during render (not in an effect) when the component is handed a
  // different card. Long grids reuse these components as they scroll, and an
  // effect would leave the previous card's failure state applied for a frame —
  // briefly showing a card back over art that loads perfectly well.
  const key = chain.join('|');
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (step !== 0) setStep(0);
  }

  const current = chain[Math.min(step, chain.length - 1)];
  const isBack = current === back;

  return (
    <img
      {...imgProps}
      src={current}
      alt={alt ?? card?.name ?? ''}
      // Lets callers style or test the placeholder state without re-deriving it.
      data-card-back={isBack ? 'true' : undefined}
      // A landscape card (a Riftbound battlefield) lies on its side in portrait
      // slots; index.css turns it there. The drawn back is portrait, so not it.
      data-orientation={card?.orientation === 'landscape' && !isBack ? 'landscape' : undefined}
      onError={(e) => {
        if (step < chain.length - 1) setStep(step + 1);
        imgProps.onError?.(e);
      }}
    />
  );
}
