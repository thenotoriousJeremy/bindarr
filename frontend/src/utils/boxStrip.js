import { cardTypeCategory, colorCategory, isMtgCard } from './cardSort.js';
import { getRarityTier } from './cardRarity.js';
import { changedCategories, getSortCategories } from './sortCategories.js';

// The box map draws each row of a box as a strip: one sliver per slot, coloured
// by the card in it, its rarity underneath, and a tab wherever the container's
// dividers fall. Everything here is pure so the strip can be tested without a
// DOM; components/BoxMap.jsx only positions what this returns.

// The rarity badge colours from cardRarity.js. Rare goes through a token because
// its near-white reads as nothing on the light theme.
export const RARITY_STRIP_COLORS = {
  uncommon: '#3b82f6',
  rare: 'var(--strip-rare)',
  top: '#f59e0b',
};

// The category a card is painted by: colour identity for Magic, ink for Lorcana
// and energy type for a Pokémon. Trainers and Energy have no type, and would
// otherwise all read as Colorless, so they are painted as what they are.
export function stripColorKey(card) {
  if (!card) return null;
  if (isMtgCard(card)) return colorCategory(card);
  if (card.supertype === 'Trainer' || card.supertype === 'Energy') return card.supertype;
  return cardTypeCategory(card);
}

// Commons stay blank, so the cards worth finding are the ones that show.
export function stripRarityKey(card) {
  if (!card) return null;
  const tier = getRarityTier(card.rarity);
  return tier === 'common' ? null : tier;
}

// Consecutive slots with the same key, as [start, end) runs. Empty slots are
// slots like any other: a run of them is a run whose key is null.
export function stripRuns(slots, keyOf) {
  const runs = [];
  slots.forEach((slot, i) => {
    const key = keyOf(slot);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, key });
  });
  return runs;
}

// The runs as one hard-stop gradient across the strip, so a 400-card row is a
// single element rather than 400. colorOf returns null for a run left clear.
export function stripGradient(runs, total, colorOf) {
  if (runs.length === 0 || !total) return 'none';
  const pct = (n) => `${+(n / total * 100).toFixed(3)}%`;
  const stops = runs.map(run => `${colorOf(run.key) || 'transparent'} ${pct(run.start)} ${pct(run.end)}`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// Where the container's dividers fall along a row: the same breaks that put a
// divider card into the coverflow. depth 0 is the first divider field (the one
// that gets a labelled tab); deeper breaks, a rarity change inside a set say,
// are drawn as ticks. A tab covers the slots up to the next break at its depth
// or above, which is what its tooltip counts.
export function stripTabs(slots, sortOrder, setsList = []) {
  const tabs = [];
  let lastCats = [];
  let lastFilled = -1;
  slots.forEach((card, index) => {
    if (!card) return;
    lastFilled = index;
    const cats = getSortCategories(card, sortOrder, setsList);
    const changed = changedCategories(cats, lastCats);
    if (cats.length > 0) lastCats = cats;
    if (changed.length === 0) return;
    tabs.push({ index, depth: cats.length - changed.length, label: changed[0].label, color: changed[0].color });
  });
  tabs.forEach((tab, i) => {
    const next = tabs.slice(i + 1).find(other => other.depth <= tab.depth);
    tab.end = next ? next.index : lastFilled + 1;
    tab.count = slots.slice(tab.index, tab.end).filter(Boolean).length;
  });
  return tabs;
}
