// Deck decklist text <-> card list. Export builds standard formats that paste
// into Pokémon TCG Live (ptcgl), MTG Arena (mtga), or a plain generic list.
// parseDeckLine is the inverse used by import so the app round-trips its own
// export (and tolerates lists copied out of those tools).

// ponytail: set code is the raw stored set_id uppercased. PTCGL/MTGA use their
// own set abbreviations that don't always equal our set_id; import matches by
// name so this stays correct on re-import, but a foreign tool may want the
// user to fix the code. Good enough until someone needs exact PTCGL codes.
function cardLine(c, format) {
  const set = String(c.set_id || c.set_code || '').toUpperCase();
  const num = c.number || '';
  if (format === 'mtga') return `${c.quantity} ${c.name}${set ? ` (${set})` : ''}${num ? ` ${num}` : ''}`;
  if (format === 'ptcgl') return `${c.quantity} ${c.name}${set ? ` ${set}` : ''}${num ? ` ${num}` : ''}`;
  return `${c.quantity} ${c.name}`; // plain
}

export function buildDeckExport(cards, format = 'ptcgl') {
  if (!cards || !cards.length) return '';

  // Buylist: only the copies the deck needs beyond what's already owned,
  // as TCGplayer Mass Entry lines ("2 Card Name"). owned_qty comes from the
  // deck detail query.
  if (format === 'buylist') {
    return cards
      .map(c => ({ name: c.name, need: Math.max(0, (c.quantity || 0) - (c.owned_qty || 0)) }))
      .filter(c => c.need > 0)
      .map(c => `${c.need} ${c.name}`)
      .join('\n');
  }

  if (format === 'ptcgl') {
    const groups = { 'Pokémon': [], 'Trainer': [], 'Energy': [] };
    for (const c of cards) {
      const st = String(c.supertype || '').toLowerCase();
      if (st.includes('pok')) groups['Pokémon'].push(c);
      else if (st.includes('energy')) groups['Energy'].push(c);
      else groups['Trainer'].push(c);
    }
    const out = [];
    for (const key of ['Pokémon', 'Trainer', 'Energy']) {
      const g = groups[key];
      if (!g.length) continue;
      const count = g.reduce((s, c) => s + c.quantity, 0);
      out.push(`${key}: ${count}`);
      g.forEach(c => out.push(cardLine(c, 'ptcgl')));
      out.push('');
    }
    out.push(`Total Cards: ${cards.reduce((s, c) => s + c.quantity, 0)}`);
    return out.join('\n');
  }

  if (format === 'mtga') {
    return 'Deck\n' + cards.map(c => cardLine(c, 'mtga')).join('\n');
  }

  return cards.map(c => cardLine(c, 'plain')).join('\n');
}

// A collector number as exporters write it: whatever follows the set code up to
// the next space, as long as it has a digit. "263", "12a", "CON-31" (The List),
// "339★" and "118†" (Scryfall's own variant marks, part of the number).
const NUMBER = String.raw`[^\s*()[\]]*\d[^\s*()[\]]*`;
const XMAGE = new RegExp(String.raw`\[([A-Za-z0-9]{2,6}):(${NUMBER})\]`);
// Lazy name, end-anchored: the LAST "(SET) NUM" is the printing, so a name with
// parentheses of its own ("B.F.M. (Big Furry Monster)") survives. A bare "foil"
// only counts after a printing: Foil is also a card.
const PAREN = new RegExp(String.raw`^(.*?)\s*\(([A-Za-z0-9]{2,6})\)(?:\s+#?(${NUMBER}))?(?:\s+(foil|etched))?$`, 'i');
// PTCGL "name SETCODE number", anchored on BOTH ends so it never eats a name that
// legitimately ends in an uppercase token ("Pikachu V", "Mewtwo GX").
const PTCGL = /^(.+?)\s+([A-Z]{2,4})\s+(\d+[a-zA-Z]?)$/;

// Pull {qty, name} out of one decklist line, plus the printing when the line names
// one: `set`, `number` and `foil` are only present when the line said so.
// "4 Pikachu ex SVI 63", "4 Lightning Bolt (2X2) 117", "2 Pikachu (SVI) #63",
// "1 Sol Ring (C21) 263 *F*", "1 Master Transmuter (PLST) CON-31",
// "4 [M10:146] Lightning Bolt" and "4 Pikachu" all yield the bare card name. The
// marker and the set-prefixed number used to stay stuck to it ("Master
// Transmuter CON-31"), and that matched no card. Same grammar as the backend's
// parseDecklistLine (backend/src/utils/csvMappers.js).
export function parseDeckLine(line) {
  const m = String(line).trim().match(/^(\d+)x?\s+(.+)$/i);
  if (!m) return null;
  const qty = parseInt(m[1], 10);
  let rest = m[2];
  let set;
  let number;

  // *F* (foil) and *E* (etched) markers, and any other *TAG*.
  let foil = /\*(?:F|E|foil|etched)\*/i.test(rest);
  rest = rest.replace(/\*[^*\s]*\*/g, ' ');

  const xmage = rest.match(XMAGE);
  if (xmage) {
    [, set, number] = xmage;
    rest = rest.replace(xmage[0], ' ');
  }
  // Archidekt's [Category] and ^Label^ tags name nothing about the card.
  rest = rest.replace(/\[[^\]]*\]|\^[^^]*\^/g, ' ').replace(/\s+/g, ' ').trim();

  if (!set) {
    const paren = rest.match(PAREN);
    const ptcgl = !paren && rest.match(PTCGL);
    if (paren) {
      [, rest, set, number] = paren;
      foil = foil || !!paren[4];
    } else if (ptcgl) {
      [, rest, set, number] = ptcgl;
    }
  }

  const name = rest
    .replace(/\s*#\d+[a-zA-Z]?$/, '')      // "#63"
    .replace(/\s+\d+[a-zA-Z]?$/, '')       // trailing bare collector number
    .trim();
  if (!name) return null;

  const parsed = { qty, name };
  if (set) parsed.set = set.toUpperCase();
  if (number) parsed.number = number;
  if (foil) parsed.foil = true;
  return parsed;
}

// Which of a name search's results a parsed line means. The search matches names
// by substring ("Island" also finds "Island Sanctuary"), so an exact name beats
// the first hit, and the printing the line names beats both.
export function pickDeckLineCard(cards, parsed) {
  if (!cards || !cards.length) return null;
  const lower = (s) => String(s || '').toLowerCase();
  const named = cards.filter(c => lower(c.name) === lower(parsed?.name));
  const printing = parsed?.set && parsed?.number
    ? cards.find(c => lower(c.set_id) === lower(parsed.set) && lower(c.number) === lower(parsed.number))
    : null;
  return printing || named[0] || cards[0];
}
