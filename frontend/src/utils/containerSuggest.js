// Cross-location "best container" suggestion engine.
//
// Previously the sorting assistant could only recommend a slot WITHIN a
// container the user had already picked, and the per-container `assignedSets`
// config was written but never read by anything. This module fixes both: given
// an unsorted card and every location (plus the full card list), it scores all
// containers and returns a ranked recommendation with a human-readable reason.

const BOX_TYPES = ['Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand'];
const BINDER_TYPES = ['Binder', 'Toploader Binder'];

function parseConfig(loc) {
  if (!loc || !loc.description) return {};
  try {
    const d = loc.description.trim();
    if (d.startsWith('{') && d.endsWith('}')) return JSON.parse(d);
  } catch { /* not JSON config */ }
  return {};
}

function pocketsFor(pageStyle) {
  return pageStyle === '2x2' ? 4 : pageStyle === '3x4' ? 12 : 9;
}

// Physical capacity of a container (best-effort from its configured shape).
export function capacityOf(loc) {
  const cfg = parseConfig(loc);
  if (BINDER_TYPES.includes(loc.type)) return (loc.max_pages || 30) * pocketsFor(loc.page_style);
  if (BOX_TYPES.includes(loc.type)) return (loc.max_rows || 3) * (cfg.rowCapacity || 40);
  if (loc.type === 'Deck Box') return cfg.targetDeckSize || 60;
  return loc.max_capacity || 1000;
}

function primaryType(card) {
  const t = card?.types;
  if (Array.isArray(t)) return t[0];
  if (typeof t === 'string') return t.split(',')[0]?.trim();
  return undefined;
}

// Build per-location profiles (count, sets present, types present) from the
// full card list in one pass, so scoring many cards stays cheap.
export function buildLocationProfiles(allCards) {
  const profiles = new Map();
  const ensure = (id) => {
    if (!profiles.has(id)) profiles.set(id, { count: 0, sets: new Set(), types: new Set() });
    return profiles.get(id);
  };
  for (const c of allCards) {
    if (!c.location_id) continue;
    const p = ensure(c.location_id);
    p.count += 1;
    if (c.set_name) p.sets.add(c.set_name);
    const pt = primaryType(c);
    if (pt) p.types.add(pt);
  }
  return profiles;
}

// Score a single (card, location) pair. Higher is better; null means unusable.
function scoreLocation(card, loc, profile) {
  // Decks are hand-curated; never auto-route loose cards into them.
  if (loc.type === 'Deck Box') return null;

  const cfg = parseConfig(loc);
  const count = profile?.count || 0;
  const capacity = capacityOf(loc);
  const free = capacity - count;
  if (free <= 0) return null; // full — not a candidate

  let score = 0;
  const reasons = [];

  const assigned = Array.isArray(cfg.assignedSets) ? cfg.assignedSets : [];
  if (card.set_name && assigned.some((s) => s.toLowerCase() === card.set_name.toLowerCase())) {
    score += 100;
    reasons.push(`assigned to ${card.set_name}`);
  } else if (card.set_name && profile?.sets.has(card.set_name)) {
    score += 45;
    reasons.push(`already holds ${card.set_name}`);
  } else {
    const pt = primaryType(card);
    if (pt && profile?.types.has(pt)) {
      score += 12;
      reasons.push(`matches ${pt} cards here`);
    }
  }

  // Gentle preference for containers with breathing room, and a small nudge
  // toward binders for singles worth showing off vs. bulk boxes.
  score += Math.min(free, 200) * 0.02;
  if (BINDER_TYPES.includes(loc.type)) score += 1;

  if (reasons.length === 0) reasons.push(`has ${free} free slot${free !== 1 ? 's' : ''}`);

  return { score, reason: reasons[0], free, capacity };
}

// Returns ranked candidates: [{ location, score, reason, free, capacity }].
export function suggestContainers(card, locations, profiles, { limit = 3 } = {}) {
  if (!card || !Array.isArray(locations)) return [];
  const scored = [];
  for (const loc of locations) {
    const res = scoreLocation(card, loc, profiles.get(loc.id));
    if (res) scored.push({ location: loc, ...res });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function suggestBestContainer(card, locations, profiles) {
  return suggestContainers(card, locations, profiles, { limit: 1 })[0] || null;
}
