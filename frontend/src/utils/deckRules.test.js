// Self-check for the deck builder's side of the deck rules: that the shared module
// (shared/deckRules.mjs) resolves from here, and that every warning it can raise
// reads as a real sentence in en.json — no raw codes, no unfilled {placeholders}.
// The rules themselves are tested case by case in backend/test/deckrules.test.js.
// Run: `node src/utils/deckRules.test.js`
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { deckWarnings, formatNames, rulesFor, ruleWarningText } from './deckRules.js';
import { translate } from './translate.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const t = (key, vars) => translate(en, en, 'en', key, vars);

// The table the server enforces is the one the format pickers list.
assert.deepStrictEqual(formatNames('lorcana'), ['Core (Constructed)', 'Casual', 'Draft / Sealed']);
assert.strictEqual(formatNames('mtg')[0], 'Commander / EDH');

const words = (line) => line.split(/[^A-Za-z]+/).filter(Boolean);
const card = (name, line, extra = {}) => ({ id: name, name, quantity: 1, game: 'mtg', subtypes: words(line), color_identity: [], oracle_text: 'x', ...extra });

// A deck that breaks every Commander rule at once.
const warnings = deckWarnings({
  game: 'mtg',
  format: 'Commander / EDH',
  cards: [
    card('Krenko, Mob Boss', 'Legendary Creature — Goblin', { is_commander: 1, color_identity: ['Red'] }),
    card("Gishath, Sun's Avatar", 'Legendary Creature — Dinosaur', { is_commander: 1, color_identity: ['Red'] }),
    card('Goblin Guide', 'Creature — Goblin', { is_commander: 1, color_identity: ['Red'] }),
    card('Sol Ring', 'Artifact', { quantity: 2 }),
    card('Llanowar Elves', 'Creature — Elf', { color_identity: ['Green'] }),
  ],
});
const codes = warnings.map(w => w.code);
for (const code of ['size_exact', 'copy_limit', 'commander_too_many', 'commander_not_legal', 'color_identity']) {
  assert.ok(codes.includes(code), `expected a ${code} warning, got ${codes}`);
}
// A pair of arbitrary legends, and a deck with no commander at all.
const pair = deckWarnings({ game: 'mtg', format: 'Commander / EDH', cards: [
  card('Krenko, Mob Boss', 'Legendary Creature — Goblin', { is_commander: 1 }),
  card("Gishath, Sun's Avatar", 'Legendary Creature — Dinosaur', { is_commander: 1 }),
] });
assert.ok(pair.some(w => w.code === 'commander_pair'));
const none = deckWarnings({ game: 'mtg', format: 'Modern', cards: [card('Lightning Bolt', 'Instant', { quantity: 61 })] });
const missing = deckWarnings({ game: 'mtg', format: 'Commander / EDH', cards: [card('Forest', 'Basic Land — Forest', { quantity: 100 })] });

const format = rulesFor('mtg', 'Commander / EDH').format;
for (const warning of [...warnings, ...pair, ...none, ...missing]) {
  const text = ruleWarningText(t, warning, format);
  assert.ok(!text.startsWith('deck.') && text !== warning.code, `${warning.code} has no sentence: ${text}`);
  assert.ok(!/\{\w+\}/.test(text), `${warning.code} left a placeholder unfilled: ${text}`);
}

assert.strictEqual(
  ruleWarningText(t, { code: 'size_exact', expected: 100, actual: 7 }, 'Commander / EDH'),
  'Commander / EDH decks have exactly 100 cards; this one has 7.'
);
// Colour identity names the cards and their colours, and the plural follows the count.
assert.strictEqual(
  ruleWarningText(t, { code: 'color_identity', identity: ['U', 'R'], cards: [{ name: 'Llanowar Elves', colors: ['G'] }] }),
  "1 card is outside the commander's color identity (UR): Llanowar Elves (G)"
);
// A long list is cut short rather than taking over the panel.
const many = Array.from({ length: 9 }, (_, i) => ({ name: `Card ${i}`, colors: ['G'] }));
assert.match(ruleWarningText(t, { code: 'color_identity', identity: [], cards: many }), /^9 cards .*\(colorless\).*Card 5 \(G\) \(\+3 more\)$/);

console.log('deckRules self-check passed');
