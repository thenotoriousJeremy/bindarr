// Riftbound pieces the UI needs: the Riot notice, landscape detection and deck
// grouping. The deck rules themselves are the riftbound entry in
// shared/deckRules.mjs, shared with the server.

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
