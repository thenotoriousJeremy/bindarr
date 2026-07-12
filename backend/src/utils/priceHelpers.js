// SQLite's CURRENT_TIMESTAMP stores UTC but as a naive "YYYY-MM-DD HH:MM:SS"
// string with no timezone marker. JS's Date parser treats a string like that
// as LOCAL time, so on any server not running in UTC, a value that's really
// "now" gets parsed as hours off — enough to misorder it against a properly
// UTC-tagged timestamp (e.g. an ISO string with a trailing Z). Always read
// SQLite datetimes through this so they compare correctly against Date.now()
// or other real UTC timestamps.
function parseSqliteUtc(str) {
  if (!str) return new Date(NaN);
  return /Z$|[+-]\d\d:\d\d$/.test(str) ? new Date(str) : new Date(str.replace(' ', 'T') + 'Z');
}

function resolveCardPrice(card) {
  if (!card) return 0;
  if (card.printing === 'Holofoil' && card.price_holofoil !== null && card.price_holofoil > 0) {
    return card.price_holofoil;
  }
  if (card.printing === 'Reverse Holofoil' && card.price_reverse_holofoil !== null && card.price_reverse_holofoil > 0) {
    return card.price_reverse_holofoil;
  }
  if (card.printing === 'Normal' && card.price_normal !== null && card.price_normal > 0) {
    return card.price_normal;
  }
  return card.price_trend || 0;
}

// position orders cards WITHIN a single compartment (a binder page, a box
// row) — see compartmentSort.js for how a card's compartment+position is
// chosen in the first place.
async function rebalanceCompartmentPositions(db, compartmentId, userId) {
  if (!compartmentId) return;
  const cards = await db.all(`SELECT id FROM collection WHERE compartment_id = ? AND user_id = ? ORDER BY position ASC`, [compartmentId, userId]);
  for (let i = 0; i < cards.length; i++) {
    const cleanPos = (i + 1) * 1000;
    await db.run(`UPDATE collection SET position = ? WHERE id = ?`, [cleanPos, cards[i].id]);
  }
}

const isVintageSet = (setId) => {
  const id = (setId || '').toLowerCase();
  return id.startsWith('base') || id.startsWith('gym') || id.startsWith('neo') ||
         id.startsWith('lc') || id.startsWith('ecard') || id.startsWith('ex') ||
         id.startsWith('pop') || id.startsWith('promo1') || id.startsWith('si') ||
         id.startsWith('xy12') || id.startsWith('cel25');
};

module.exports = {
  parseSqliteUtc,
  resolveCardPrice,
  rebalanceCompartmentPositions,
  isVintageSet
};
