// Riftbound pieces the UI needs: the Riot notice, deck grouping, and the
// per-card copy limit the deck builder checks before asking the server.
//
// The deck rules themselves live in backend/src/utils/riftboundDeck.js; the server
// reports what a deck breaks as `warnings` on GET /api/decks/:id. copyLimit and
// ruleName here mirror that file (as isBasicEnergyOrLand mirrors deckRules.js), so
// the "+" button agrees with what the server will accept.

// Riot's Legal Jibber Jabber (section 6) and the Riftbound developer policy
// require this exact statement wherever Riftbound content appears. It is NOT run
// through t(): the wording is Riot's, not ours to translate.
export const RIOT_NOTICE = 'Bindarr was created under Riot Games\' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.';

const parseList = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch { return []; } }
  return [];
};

export const isLandscape = (card) => card?.orientation === 'landscape';

// DeckBuilder groups, in deck-list order.
export const RIFTBOUND_GROUPS = ['Legend', 'Champion', 'Unit', 'Spell', 'Gear', 'Rune', 'Battlefield', 'Other'];

export function riftboundGroup(card) {
  const subs = parseList(card?.subtypes);
  if (subs.includes('Token')) return 'Other';
  const type = card?.supertype;
  if (type === 'Unit') return subs.includes('Champion') ? 'Champion' : 'Unit';
  return RIFTBOUND_GROUPS.includes(type) ? type : 'Other';
}
