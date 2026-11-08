import assert from 'node:assert';
import { buildDeckExport, parseDeckLine, pickDeckLineCard } from './deckText.js';

const cards = [
  { quantity: 4, name: 'Pikachu ex', set_id: 'svi', number: '63', supertype: 'Pokémon' },
  { quantity: 2, name: "Boss's Orders", set_id: 'pal', number: '172', supertype: 'Trainer' },
  { quantity: 6, name: 'Lightning Energy', set_id: 'sve', number: '4', supertype: 'Energy' },
];

const ptcgl = buildDeckExport(cards, 'ptcgl');
assert.ok(ptcgl.includes('Pokémon: 4'), 'ptcgl Pokémon count');
assert.ok(ptcgl.includes('Energy: 6'), 'ptcgl Energy count');
assert.ok(ptcgl.includes('4 Pikachu ex SVI 63'), 'ptcgl card line');
assert.ok(ptcgl.trim().endsWith('Total Cards: 12'), 'ptcgl total');

const mtga = buildDeckExport(cards, 'mtga');
assert.ok(mtga.startsWith('Deck\n'), 'mtga header');
assert.ok(mtga.includes('4 Pikachu ex (SVI) 63'), 'mtga card line');

assert.strictEqual(buildDeckExport(cards, 'plain').split('\n')[0], '4 Pikachu ex', 'plain line');

assert.deepStrictEqual(parseDeckLine('4 Pikachu ex SVI 63'), { qty: 4, name: 'Pikachu ex', set: 'SVI', number: '63' });
assert.deepStrictEqual(parseDeckLine('4 Lightning Bolt (2X2) 117'), { qty: 4, name: 'Lightning Bolt', set: '2X2', number: '117' });
assert.deepStrictEqual(parseDeckLine('2 Pikachu (SVI) #63'), { qty: 2, name: 'Pikachu', set: 'SVI', number: '63' });
assert.deepStrictEqual(parseDeckLine('4 Pikachu'), { qty: 4, name: 'Pikachu' });
assert.deepStrictEqual(parseDeckLine('1 Mewtwo GX'), { qty: 1, name: 'Mewtwo GX' }, 'trailing GX kept');
assert.deepStrictEqual(parseDeckLine('3 Pikachu V'), { qty: 3, name: 'Pikachu V' }, 'trailing V kept');
assert.strictEqual(parseDeckLine('not a card line'), null);

// Markers and set-prefixed numbers are parsed out of the name, never left on it:
// "Master Transmuter CON-31" and "Sol Ring 263 *F*" match no card.
assert.deepStrictEqual(parseDeckLine('1 Master Transmuter (PLST) CON-31'),
  { qty: 1, name: 'Master Transmuter', set: 'PLST', number: 'CON-31' });
assert.deepStrictEqual(parseDeckLine('1 Rescue, Pepper Potts (MSC) 755 *F*'),
  { qty: 1, name: 'Rescue, Pepper Potts', set: 'MSC', number: '755', foil: true });
assert.strictEqual(parseDeckLine('1 Sol Ring (C21) 263 *E*').foil, true, 'etched is a foil finish');
assert.deepStrictEqual(parseDeckLine('1 Blaze (POR) 118†'), { qty: 1, name: 'Blaze', set: 'POR', number: '118†' },
  "Scryfall's dagger is part of the number");
assert.deepStrictEqual(parseDeckLine('1 Mountain (7ED) 339★ *F*'),
  { qty: 1, name: 'Mountain', set: '7ED', number: '339★', foil: true });
for (const xmage of ['4 [M10:146] Lightning Bolt', '4 Lightning Bolt [M10:146]']) {
  assert.deepStrictEqual(parseDeckLine(xmage), { qty: 4, name: 'Lightning Bolt', set: 'M10', number: '146' }, xmage);
}
assert.deepStrictEqual(parseDeckLine('1x Sol Ring (c21) 263 [Ramp] ^Have,#37d67a^'),
  { qty: 1, name: 'Sol Ring', set: 'C21', number: '263' }, 'Archidekt tags');
assert.deepStrictEqual(parseDeckLine('1 Foil (PCY) 34'), { qty: 1, name: 'Foil', set: 'PCY', number: '34' }, 'Foil is a card');
assert.strictEqual(parseDeckLine('1 Sol Ring (C21) 263 foil').foil, true, 'a finish word after a printing');
assert.strictEqual(parseDeckLine('1 B.F.M. (Big Furry Monster) (UGL) 28').name, 'B.F.M. (Big Furry Monster)');
assert.strictEqual(parseDeckLine(`1 ${' '.repeat(100000)}(`), null, 'a wall of text is not a card line');
for (const line of ['1 Steel Hellkite (FDN) 681', '10 Island (ORI) 259', '1 Master Transmuter (PLST) CON-31',
  "1 An Offer You Can't Refuse (FIC) 267", '1 Rescue, Pepper Potts (MSC) 755 *F*']) {
  assert.doesNotMatch(parseDeckLine(line).name, /\d|\*/, `a token stayed on the name: ${line}`);
}

// The search behind a deck import matches names by substring: the exact name
// wins over the first hit, and the printing the line names wins over both.
const hits = [
  { id: 'sanctuary', name: 'Island Sanctuary', set_id: 'm10', number: '15' },
  { id: 'island-ori', name: 'Island', set_id: 'ori', number: '259' },
  { id: 'island-m10', name: 'Island', set_id: 'm10', number: '234' },
];
assert.strictEqual(pickDeckLineCard(hits, parseDeckLine('4 Island')).id, 'island-ori');
assert.strictEqual(pickDeckLineCard(hits, parseDeckLine('4 Island (M10) 234')).id, 'island-m10');
assert.strictEqual(pickDeckLineCard(hits, parseDeckLine('4 Island (KTK) 1')).id, 'island-ori', 'an unowned printing falls back');
assert.strictEqual(pickDeckLineCard([], parseDeckLine('4 Island')), null);

console.log('deckText self-check passed');

// buylist: only shortfall vs owned, TCGplayer mass-entry lines
const bl = buildDeckExport([
  { quantity: 4, name: 'Pikachu ex', owned_qty: 1 },
  { quantity: 2, name: 'Ultra Ball', owned_qty: 2 },
  { quantity: 3, name: 'Iono', owned_qty: 0 },
], 'buylist');
assert.strictEqual(bl, '3 Pikachu ex\n3 Iono', 'buylist shortfall lines');

console.log('deckText buylist check passed');
