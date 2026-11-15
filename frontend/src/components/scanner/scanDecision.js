// What a scan's answer means for the scanner: file the top card, or ask.
//
// Pure, so the rules can be tested without a camera (utils/scanDecision.test.js).
// Moved out of CameraScanner unchanged.
import { SCAN_MATCH_MIN_SCORE, SCAN_MATCH_MIN_INLIERS, SCAN_MATCH_MIN_MARGIN } from './scanConstants.js';

// Is this resolved card the printing ORB reported? Set + number is the
// identity; the name is not checked because the index and the provider can
// spell it differently, which is exactly the disagreement that used to make
// candidates vanish.
// Number compared with leading zeros stripped: TCGdex writes '013' where
// pokemontcg.io and the TCGplayer product map write '13', so a string compare
// threw away every correct TCGdex answer.
export const sameNumber = (a, b) => {
  const norm = (n) => String(n ?? '').trim().toLowerCase().replace(/^0+(?=\d)/, '');
  return !!norm(a) && norm(a) === norm(b);
};

export const sameCard = (card, cand) => !!card && !!cand
  && sameNumber(card.number, cand.number)
  && (String(card.set_id).toLowerCase() === String(cand.set).toLowerCase()
    || String(card.set_name || '').toLowerCase() === String(cand.set).toLowerCase());

// One /api/scan-match answer: { candidates, verified, notInCatalog, ambiguousPrinting? }.
export function scanDecision({ candidates, verified, notInCatalog, ambiguousPrinting: serverAmbiguous }) {
  const top = (candidates && candidates[0]) || null;
  const second = (candidates && candidates[1]) || null;
  const confident = !!top && (verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE);
  // Printing ambiguity: basic lands (and other low-art cards) share one
  // big symbol + frame, so ORB scores nearly tie across every printing
  // of the same card. A near-tied same-name runner-up means the image
  // can't tell the printings apart — so DON'T auto-add the top pick's
  // set; fall through to the picker and let the user choose the set.
  // The server can say so itself (PROV-10: reprints sharing one
  // illustration); without that flag, an older server, the local
  // near-tie check still decides.
  const ambiguousPrinting = serverAmbiguous === true || (!!top && !!second && top.name === second.name
    && (top.set !== second.set || top.number !== second.number)
    && (verified ? second.inliers >= top.inliers * 0.7 : second.score >= top.score - 0.02));
  // Embedding matches fail differently from ORB ones: a wrong answer
  // can carry a HIGH cosine (0.88 on the eval sample) while sitting a
  // hair above the runner-up, because the two cards genuinely look
  // alike. Absolute similarity cannot separate those; the margin can.
  // This is deliberately name-blind — the confident wrong answers were
  // different cards, which ambiguousPrinting above never catches.
  const lowMargin = !verified && !!top && !!second && (top.score - second.score) < SCAN_MATCH_MIN_MARGIN;
  // The server says nothing in any catalog resembles this card, so the
  // candidates are the nearest strangers rather than a shortlist.
  // Auto-add is exactly wrong here — a card the catalog has never heard
  // of is the one case where a high cosine and a clean margin prove
  // nothing — but the list still goes on screen: it costs the user one
  // glance and beats claiming the card does not exist.
  const confidentPick = confident && !ambiguousPrinting && !lowMargin && !notInCatalog;
  return { top, second, confident, ambiguousPrinting, lowMargin, confidentPick };
}

// Search results, best visual match first; without scores (no photo was sent),
// cards with art ahead of cards without.
export function rankByScore(results) {
  return [...results].sort((a, b) => {
    const aScore = a.score !== undefined && a.score !== null ? a.score : -Infinity;
    const bScore = b.score !== undefined && b.score !== null ? b.score : -Infinity;
    if (aScore !== bScore) return bScore - aScore;
    return (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0);
  });
}
