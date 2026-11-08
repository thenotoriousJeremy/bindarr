// The shared Scryfall-syntax module (shared/scryfallQuery.mjs): detection of syntax
// against plain card names, the grammar and its errors, and the evaluator the
// collection filter and the deck builder's collection search run over stored rows.
//
// The fixture is the row shape GET /api/collection hands the collection screen —
// colours as names in `types`, display-word rarities, the copy's printing,
// language and price — not Scryfall's own shape. No network, no database.
// No framework — plain node + assert. Run: `node test/scryfallquery.test.js`
const assert = require('assert');
const LANGUAGES = require('../../shared/languages.json');

// Type words as normalizeCard stores them in `subtypes`, so a row is complete
// with or without its type_line.
const card = (id, name, fields) => ({
  id, name, game: 'mtg', supertype: 'MTG', printed_name: null,
  subtypes: (fields.type_line || '').split(/[^A-Za-z]+/).filter(Boolean),
  types: [], color_identity: [], cmc: 0, rarity: 'Common', set_id: 'tst', set_name: 'Test', number: '1',
  language: 'English', printing: 'Normal', price_trend: 0, price_currency: 'USD',
  oracle_text: '', mana_cost: '', power: null, toughness: null, loyalty: null, keywords: [],
  ...fields,
});

const CARDS = [
  card('elves', 'Llanowar Elves', { type_line: 'Creature — Elf Druid', types: ['Green'], color_identity: ['Green'], cmc: 1, mana_cost: '{G}', power: '1', toughness: '1', oracle_text: '{T}: Add {G}.', set_id: 'm19', number: '314', price_trend: 0.25 }),
  card('bolt', 'Lightning Bolt', { type_line: 'Instant', types: ['Red'], color_identity: ['Red'], cmc: 1, mana_cost: '{R}', oracle_text: 'Lightning Bolt deals 3 damage to any target.', set_id: 'm10', number: '146', printing: 'Holofoil', price_trend: 2.5 }),
  card('bolt-ja', 'Lightning Bolt', { printed_name: '稲妻', language: 'Japanese', type_line: 'Instant', types: ['Red'], color_identity: ['Red'], cmc: 1, mana_cost: '{R}', oracle_text: 'Lightning Bolt deals 3 damage to any target.', set_id: 'sta', number: '42', price_trend: 1.2, price_currency: 'EUR' }),
  card('kenrith', 'Kenrith, the Returned King', { type_line: 'Legendary Creature — Human Noble', types: ['White'], color_identity: ['White', 'Blue', 'Black', 'Red', 'Green'], cmc: 5, mana_cost: '{4}{W}', power: '5', toughness: '5', oracle_text: '{R}: All creatures gain trample and haste until end of turn.\n{1}{G}: Put a +1/+1 counter on target creature.', rarity: 'Mythic', set_id: 'eld', number: '303', price_trend: 3 }),
  card('reef', 'Shivan Reef', { type_line: 'Land', color_identity: ['Blue', 'Red'], oracle_text: '{T}: Add {C}.\n{T}: Add {U} or {R}. Shivan Reef deals 1 damage to you.', rarity: 'Rare', set_id: 'dmu', number: '255', price_trend: 1 }),
  card('sol', 'Sol Ring', { type_line: 'Artifact', cmc: 1, mana_cost: '{1}', oracle_text: '{T}: Add {C}{C}.', rarity: 'Uncommon', set_id: 'c21', number: '263', price_trend: 1.5 }),
  card('forest', 'Forest', { type_line: 'Basic Land — Forest', color_identity: ['Green'], oracle_text: '({T}: Add {G}.)', set_id: 'lea', number: '294', price_trend: 0.1 }),
  card('fire-ice', 'Fire // Ice', { type_line: 'Instant // Instant', types: ['Red', 'Blue'], color_identity: ['Blue', 'Red'], cmc: 4, mana_cost: '{1}{R} // {1}{U}', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.\n//\nTap target permanent.\nDraw a card.', rarity: 'Uncommon', set_id: 'apc', number: '128', price_trend: 0.8 }),
  card('signet', 'Azorius Signet', { printed_name: 'アゾリウスの印鑑', language: 'Japanese', type_line: 'Artifact', color_identity: ['White', 'Blue'], cmc: 2, mana_cost: '{2}', oracle_text: '{1}, {T}: Add {W}{U}.', rarity: 'Special', set_id: 'tsr', number: '400', price_trend: 0.5 }),
  card('dack', "Dack's Duplicate", { type_line: 'Creature — Shapeshifter', types: ['Blue', 'Red'], color_identity: ['Blue', 'Red'], cmc: 4, mana_cost: '{2}{U}{R}', power: '0', toughness: '0', keywords: ['Haste', 'Dethrone'], oracle_text: "You may have Dack's Duplicate enter the battlefield as a copy of any creature on the battlefield, except it has haste and dethrone.", rarity: 'Rare', set_id: 'cns', number: '51a', price_trend: 4 }),
  card('bears', 'Grizzly Bears', { type_line: 'Creature — Bear', types: ['Green'], color_identity: ['Green'], cmc: 2, mana_cost: '{1}{G}', power: '2', toughness: '2', set_id: 'lea', number: '189', price_trend: 0.3 }),
  card('angel', 'Serra Angel', { type_line: 'Creature — Angel', types: ['White'], color_identity: ['White'], cmc: 5, mana_cost: '{3}{W}{W}', power: '4', toughness: '4', keywords: ['Flying', 'Vigilance'], oracle_text: 'Flying, vigilance', rarity: 'Uncommon', set_id: 'dom', number: '33', printing: 'Holofoil', price_trend: 0.4 }),
  card('goyf', 'Tarmogoyf', { type_line: 'Creature — Lhurgoyf', types: ['Green'], color_identity: ['Green'], cmc: 2, mana_cost: '{1}{G}', power: '*', toughness: '1+*', oracle_text: "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.", rarity: 'Rare', set_id: 'fut', number: '153', price_trend: 12 }),
  card('jace', 'Jace, the Mind Sculptor', { type_line: 'Legendary Planeswalker — Jace', types: ['Blue'], color_identity: ['Blue'], cmc: 4, mana_cost: '{2}{U}{U}', loyalty: '3', oracle_text: "+2: Look at the top card of target player's library. You may put that card on the bottom of that player's library.", rarity: 'Mythic', set_id: 'wwk', number: '31', price_trend: 25 }),
  card('finks', 'Kitchen Finks', { type_line: 'Creature — Ouphe', types: ['Green', 'White'], color_identity: ['Green', 'White'], cmc: 3, mana_cost: '{1}{G/W}{G/W}', power: '3', toughness: '2', keywords: ['Persist'], oracle_text: 'When Kitchen Finks enters the battlefield, you gain 2 life.\nPersist', rarity: 'Uncommon', set_id: 'shm', number: '229', price_trend: 0.6 }),
  card('probe', 'Gitaxian Probe', { type_line: 'Sorcery', types: ['Blue'], color_identity: ['Blue'], cmc: 1, mana_cost: '{U/P}', oracle_text: "({U/P} can be paid with either {U} or 2 life.)\nLook at target player's hand.\nDraw a card.", set_id: 'nph', number: '35', price_trend: 0.2 }),
  card('delver', 'Delver of Secrets', { type_line: 'Creature — Human Wizard // Creature — Human Insect', types: ['Blue'], color_identity: ['Blue'], cmc: 1, mana_cost: '{U}', power: '1', toughness: '1', keywords: ['Transform'], oracle_text: 'At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n//\nFlying', set_id: 'isd', number: '51', price_trend: 0.5 }),
  // Cached before rules text was stored: no type line, text, cost or keywords —
  // only the type words card_cache always had.
  card('counter', 'Counterspell', { type_line: undefined, subtypes: ['Instant'], types: ['Blue'], color_identity: ['Blue'], cmc: 2, oracle_text: null, mana_cost: null, keywords: null, rarity: 'Uncommon', set_id: '7ed', number: '67', price_trend: 1 }),
  card('katana', 'Ancestral Katana', { printed_name: 'Katana der Ahnen', language: 'German', type_line: 'Artifact — Equipment', cmc: 1, mana_cost: '{1}', keywords: ['Equip'], oracle_text: 'Equipped creature gets +1/+1.\nEquip {1}', set_id: 'neo', number: '1', price_trend: 0.1 }),
  card('emrakul', 'Emrakul, the Aeons Torn', { type_line: 'Legendary Creature — Eldrazi', cmc: 15, mana_cost: '{15}', power: '15', toughness: '15', keywords: ['Flying', 'Protection', 'Annihilator'], oracle_text: "This spell can't be countered.\nWhen you cast this spell, take an extra turn after this one.\nFlying, protection from spells that are one or more colors, annihilator 6", rarity: 'Mythic', set_id: 'roe', number: '4', printing: 'Holofoil', price_trend: 40 }),
  card('limdul', 'Lim-Dûl the Necromancer', { type_line: 'Legendary Creature — Human Wizard', types: ['Black'], color_identity: ['Black'], cmc: 7, mana_cost: '{5}{B}{B}', power: '4', toughness: '4', oracle_text: 'Whenever a creature an opponent controls dies, you may pay {1}{B}. If you do, return that card to the battlefield under your control.', rarity: 'Rare', set_id: 'tsb', number: '49', price_trend: 2 }),
];
const ALL_IDS = CARDS.map(c => c.id).sort();

async function main() {
  const { looksLikeSyntax, parseQuery, compileFilter, someTerm, QuerySyntaxError, ERROR_CODES } = await import('../../shared/scryfallQuery.mjs');
  const ids = (q) => {
    const matches = compileFilter(q, { languages: LANGUAGES });
    return CARDS.filter(c => matches(c)).map(c => c.id).sort();
  };
  const codeOf = (fn) => {
    try { fn(); } catch (err) {
      assert.ok(err instanceof QuerySyntaxError, `expected a QuerySyntaxError, got ${err && err.stack}`);
      assert.ok(ERROR_CODES.includes(err.code), `${err.code} has a message`);
      return err.code;
    }
    return null;
  };
  let checks = 0;

  // ---- 1. Detection: syntax versus a plain card name. A name must keep its old
  // search path, so every one of these real card names stays plain.
  const PLAIN = [
    'Lightning Bolt', 'Fire // Ice', 'Who // What // When // Where // Why', 'Circle of Protection: Red',
    'Fight or Flight', 'Life and Limb', 'Lim-Dûl the Necromancer', 'Ach! Hans, Run!', 'Kaboom!',
    'Who/What/When/Where/Why', '_____ Goblin', "Urza's Saga", '+2 Mace', 'Jace, the Mind Sculptor',
    'Kangaskhan 5/64', '稲妻', '', '   ', 'protection:',
  ];
  for (const q of PLAIN) { assert.strictEqual(looksLikeSyntax(q), false, `${JSON.stringify(q)} is a plain name`); checks++; }
  const SYNTAX = [
    't:creature', 'T:Creature', 'cmc<=3', 'c!=g', 'pow>=4', '-t:land', 'bolt -shock', '"lightning bolt"',
    '(bolt)', '!fire', '!"fire // ice"', '/^gob/', 'name:/bolt/', 'o:"draw a card"', 's:mh3 145',
    'otaq:ramp', 'Circle of Protection:Red', 'Kongming, "Sleeping Dragon"', 'B.F.M. (Big Furry Monster)',
    't:creature c:g cmc<=3 o:"draw a card" r:rare s:mh3 pow>=4 is:foil',
  ];
  for (const q of SYNTAX) { assert.strictEqual(looksLikeSyntax(q), true, `${JSON.stringify(q)} is syntax`); checks++; }

  // ---- 2. Grammar: what Scryfall documents parses.
  const PARSES = [
    'c:wu', 'c>=wu', 'c=wu', 'c<=wu', 'c!=g', 'c:m', 'c=2', 'c:esper', 'c:azorius', 'c:quandrix', 'c:colorless',
    'id:g', 'id<=esper', 'ci:c', 'commander:wu', 'id>=2', 'colour:r',
    't:"legendary creature"', 't=creature', 't:elf -t:druid',
    'o:"draw a card"', 'o:/^\\{T\\}:/', 'fo:flying', 'kw:"first strike"', 'm:{G}{G}', 'm>={2}{U}', 'm:2WW',
    'devotion:{g}{g}{g}', 'produces:g',
    'mv=even', 'mv:odd', 'cmc>=3', 'manavalue<2', 'pow>=5', 'tou<pow', 'pt>=10', 'loy=3', 'def:4',
    'r>rare', 'r:s', 'r:b', 'r>=u', 'rarity!=common',
    's:lea', 'e:m10', 'edition:eld', 'cn>100', 'cn:51a', 'b:ktk', 'st:core', 'in:lea', 'cube:vintage',
    'f:edh', 'legal:modern', 'banned:modern', 'restricted:vintage',
    'usd>5', 'eur<1', 'tix>=0.5',
    'a:"rk post"', 'artists>1', 'ft:"sorrow"', 'wm:orzhov', 'border:black', 'frame:2015', 'stamp:oval', 'game:paper',
    'year>=2024', 'date>=2024-01-01', 'new:art', 'prints>50', 'sets>20', 'papersets<3', 'illustrations>3', 'lore:urza',
    'is:foil', 'is:commander', 'not:reprint', 'has:watermark', 'layout:split',
    'oracleid:4457ed35-7c10-48c8-9776-456485fdf070', 'otag:ramp', 'oracletag:removal', 'function:card-draw',
    'atag:dragon', 'art:squirrel', 'arttag:"sword"',
    '!"lightning bolt"', '!fire', 'name:/^light/', '/bolt$/', 'name=bolt',
    'include:extras', 'unique:prints', 'order:usd', 'direction:desc', 'prefer:newest', 'display:text',
    'lang:any', 'lang:ja', 'language:japanese',
    '(t:elf or t:goblin) c:g', '-(r:c or r:u)', 't:elf and c:g', 'bolt or shock', '-"lightning"', 'T:ELF OR T:GOBLIN',
    'Circle of Protection: Red set:lea', 'Fire // Ice t:instant', '-!fire', '((t:elf))',
  ];
  for (const q of PARSES) { assert.doesNotThrow(() => parseQuery(q), `${q} should parse`); checks++; }

  // ---- 3. The tree itself.
  assert.deepStrictEqual(parseQuery('t:creature c:g'), { type: 'and', terms: [
    { type: 'term', keyword: 'type', typed: 't', cmp: ':', value: 'creature', quoted: false, regex: false },
    { type: 'term', keyword: 'color', typed: 'c', cmp: ':', value: 'g', quoted: false, regex: false },
  ] });
  const prec = parseQuery('a b or c');
  assert.strictEqual(prec.type, 'or', 'or binds loosest');
  assert.strictEqual(prec.terms[0].type, 'and');
  assert.strictEqual(parseQuery('-(r:c or r:u)').type, 'not', 'a negated group');
  assert.strictEqual(parseQuery('-(r:c or r:u)').term.type, 'or');
  assert.strictEqual(parseQuery('cmc<=3').keyword, 'manavalue', 'aliases fold to one keyword');
  assert.strictEqual(parseQuery('cmc<=3').typed, 'cmc', 'the typed spelling is kept for messages');
  assert.strictEqual(parseQuery('e:m10').keyword, 'set');
  assert.strictEqual(parseQuery('ci:wu').keyword, 'identity');
  assert.deepStrictEqual(parseQuery('o:"draw a card"').value, 'draw a card');
  assert.strictEqual(parseQuery('o:"say \\"hi\\""').value, 'say "hi"', 'an escaped quote inside quotes');
  assert.strictEqual(parseQuery('o:/^\\{T\\}:/').regex, true);
  assert.strictEqual(parseQuery('o:/^\\{T\\}:/').value, '^\\{T\\}:', 'regex escapes are kept as typed');
  assert.ok(parseQuery('Circle of Protection: Red set:lea').terms.some(t => t.type === 'name' && t.value === 'Protection:'),
    '"Protection:" before a space is part of a name');
  assert.ok(parseQuery('Fire // Ice t:instant').terms.some(t => t.type === 'name' && t.value === '//'), '// is a word');
  assert.deepStrictEqual(parseQuery('"or" t:elf').terms[0], { type: 'name', value: 'or', quoted: true }, 'a quoted "or" is a name');
  assert.deepStrictEqual(parseQuery('!"Fire // Ice"'), { type: 'name', value: 'Fire // Ice', exact: true, quoted: true });
  assert.strictEqual(someTerm(parseQuery('t:elf (c:g or -lang:ja)'), n => n.keyword === 'lang'), true, 'someTerm looks inside groups and negations');
  assert.strictEqual(someTerm(parseQuery('t:elf c:g'), n => n.keyword === 'lang'), false);
  checks += 20;

  // ---- 4. Syntax that cannot be read is NAMED, never silently empty.
  const ERRORS = [
    ['', 'empty'], ['   ', 'empty'],
    ['o:"draw a card', 'unterminatedQuote'], ['"lightning bolt', 'unterminatedQuote'], ['foo"bar', 'unterminatedQuote'],
    ['name:/^light', 'unterminatedRegex'], ['/bolt', 'unterminatedRegex'],
    ['(t:elf', 'unbalancedParens'], ['t:elf)', 'unbalancedParens'], ['((t:elf)', 'unbalancedParens'], [')(', 'unbalancedParens'],
    ['()', 'emptyGroup'], ['t:elf ()', 'emptyGroup'],
    ['-', 'danglingNegation'], ['t:elf -', 'danglingNegation'], ['(t:elf -)', 'danglingNegation'],
    ['or', 'danglingOperator'], ['bolt or', 'danglingOperator'], ['or bolt', 'danglingOperator'],
    ['bolt or or shock', 'danglingOperator'], ['and', 'danglingOperator'], ['t:elf and', 'danglingOperator'],
    ['(or t:elf)', 'danglingOperator'],
    ['t:', 'emptyValue'], ['cmc>=', 'emptyValue'], ['c:(', 'emptyValue'], ['name: bolt', 'emptyValue'], ['(t:)', 'emptyValue'],
    ['otaq:ramp', 'unknownKeyword'], ['foo=bar', 'unknownKeyword'], ['t:elf protection:red', 'unknownKeyword'],
  ];
  for (const [q, code] of ERRORS) { assert.strictEqual(codeOf(() => parseQuery(q)), code, `${JSON.stringify(q)} -> ${code}`); checks++; }
  const unknown = (() => { try { parseQuery('t:elf otaq:ramp'); } catch (e) { return e; } })();
  assert.deepStrictEqual(unknown.params, { keyword: 'otaq:' });
  assert.ok(/otaq:/.test(unknown.message) && /Unsupported/.test(unknown.message), 'the message names the key');

  // ---- 5. Evaluation over stored rows.
  const EXPECT = [
    ['t:creature', ['angel', 'bears', 'dack', 'delver', 'elves', 'emrakul', 'finks', 'goyf', 'kenrith', 'limdul']],
    ['t:creature c:g', ['bears', 'elves', 'finks', 'goyf']],
    ['t:creature c:g cmc<=3', ['bears', 'elves', 'finks', 'goyf']],
    ['t:legendary', ['emrakul', 'jace', 'kenrith', 'limdul']],
    ['t:"legendary creature"', ['emrakul', 'kenrith', 'limdul']],
    ['t:instant', ['bolt', 'bolt-ja', 'counter', 'fire-ice']],
    ['-t:land t:artifact', ['katana', 'signet', 'sol']],
    ['t:elf', ['elves']],
    ['t=elf', ['elves']],
    ['t!=creature t:artifact', ['katana', 'signet', 'sol']],
    // colours: c: means "at least", id: means "fits within"
    ['c:g', ['bears', 'elves', 'finks', 'goyf']],
    ['c=gw', ['finks']],
    ['c>=ur', ['dack', 'fire-ice']],
    ['c:m', ['dack', 'finks', 'fire-ice']],
    ['c=2', ['dack', 'finks', 'fire-ice']],
    ['c:c', ['emrakul', 'forest', 'katana', 'reef', 'signet', 'sol']],
    ['c!=g', ALL_IDS.filter(id => !['bears', 'elves', 'goyf'].includes(id))],
    ['c:izzet', ['dack', 'fire-ice']],
    ['id:g', ['bears', 'elves', 'emrakul', 'forest', 'goyf', 'katana', 'sol']],
    ['id<=izzet', ['bolt', 'bolt-ja', 'counter', 'dack', 'delver', 'emrakul', 'fire-ice', 'jace', 'katana', 'probe', 'reef', 'sol']],
    ['id=wubrg', ['kenrith']],
    ['id:esper', ['angel', 'counter', 'delver', 'emrakul', 'jace', 'katana', 'limdul', 'probe', 'signet', 'sol']],
    // mana value and mana cost
    ['cmc<=1', ['bolt', 'bolt-ja', 'delver', 'elves', 'forest', 'katana', 'probe', 'reef', 'sol']],
    ['mv=even', ['bears', 'counter', 'dack', 'fire-ice', 'forest', 'goyf', 'jace', 'reef', 'signet']],
    ['cmc>=5', ['angel', 'emrakul', 'kenrith', 'limdul']],
    ['m:{G}', ['bears', 'elves', 'goyf']],
    ['m:2WW', ['angel']],
    ['m={1}{G}', ['bears', 'goyf']],
    ['m:{G/W}', ['finks']],
    ['m:{w/g}', ['finks'], 'hybrid halves in either order'],
    ['m>={U}{R}', ['dack'], 'a split card matches face by face, not across faces'],
    ['m:{1}{U}', ['dack', 'fire-ice', 'jace'], 'either face of Fire // Ice'],
    ['m<={1}{G}', ['bears', 'elves', 'forest', 'goyf', 'katana', 'reef', 'sol'], 'a land costs nothing, which fits in anything'],
    // power, toughness, loyalty
    ['pow>=4', ['angel', 'emrakul', 'kenrith', 'limdul']],
    ['tou<pow', ['finks']],
    ['pow=0', ['dack', 'goyf'], '* counts as 0'],
    ['pt>=10', ['emrakul', 'kenrith']],
    ['loy=3', ['jace']],
    ['loy>=3 t:planeswalker', ['jace']],
    // rarity: Scryfall's order, special and mythic above rare
    ['r:rare', ['dack', 'goyf', 'limdul', 'reef']],
    ['r>rare', ['emrakul', 'jace', 'kenrith', 'signet']],
    ['r:m', ['emrakul', 'jace', 'kenrith']],
    ['r<=u t:instant', ['bolt', 'bolt-ja', 'counter', 'fire-ice']],
    ['r:s', ['signet']],
    ['rarity!=common r<rare', ['angel', 'counter', 'finks', 'fire-ice', 'sol']],
    // set and collector number
    ['s:lea', ['bears', 'forest']],
    ['e:m10', ['bolt']],
    ['S:LEA', ['bears', 'forest'], 'keywords and codes ignore case'],
    ['s:lea cn>200', ['forest']],
    ['cn:51a', ['dack']],
    ['cn>=50 cn<52', ['dack', 'delver'], '51a counts as 51'],
    ['cn:0146', ['bolt'], 'leading zeros'],
    // rules text
    ['o:"draw a card"', ['fire-ice', 'probe']],
    ['o:~', ['bolt', 'bolt-ja', 'dack', 'delver', 'finks', 'goyf', 'reef'], '~ is the card\'s own name'],
    ['o:"~ deals"', ['bolt', 'bolt-ja', 'reef']],
    ['o:flying', ['angel', 'delver', 'emrakul'], 'either face'],
    ['o:draw', ['fire-ice', 'probe'], 'a row with no stored text never matches'],
    ['-o:draw t:instant', ['bolt', 'bolt-ja', 'counter']],
    ['fo:persist', ['finks']],
    ['kw:flying', ['angel', 'emrakul']],
    ['kw:haste', ['dack']],
    ['kw:dethrone or kw:persist', ['dack', 'finks']],
    ['kw:fly', [], 'a keyword is matched whole'],
    // the copy: finish, language, price
    ['is:foil', ['angel', 'bolt', 'emrakul']],
    ['is:nonfoil t:creature c:w', ['finks', 'kenrith']],
    ['not:foil r:mythic', ['jace', 'kenrith']],
    ['lang:ja', ['bolt-ja', 'signet']],
    ['language:german', ['katana']],
    ['lang:zhs', [], 'Scryfall\'s code for a language nobody here owns'],
    ['lang:any t:artifact', ['katana', 'signet', 'sol']],
    ['-lang:en t:instant', ['bolt-ja']],
    ['usd>5', ['emrakul', 'goyf', 'jace']],
    ['eur>=1', ['bolt-ja'], 'a euro-priced copy has no dollar price, and vice versa'],
    ['usd<1 t:creature', ['angel', 'bears', 'delver', 'elves', 'finks']],
    // is: shortcuts the stored rows can answer
    ['is:permanent c:c', ['emrakul', 'forest', 'katana', 'reef', 'signet', 'sol']],
    ['is:spell c:u', ['counter', 'dack', 'delver', 'fire-ice', 'jace', 'probe']],
    ['is:historic', ['emrakul', 'jace', 'katana', 'kenrith', 'limdul', 'signet', 'sol']],
    ['is:vanilla', ['bears']],
    ['is:bear', ['bears']],
    ['is:hybrid', ['finks']],
    ['is:phyrexian', ['probe']],
    ['is:commander', ['emrakul', 'kenrith', 'limdul']],
    // names: words, phrases, exact names, printed names, accents
    ['bolt', ['bolt', 'bolt-ja']],
    ['稲妻', ['bolt-ja']],
    ['アゾリウス', ['signet']],
    ['"lightning bolt"', ['bolt', 'bolt-ja']],
    ['!fire', ['fire-ice'], 'an exact name matches either half of a split card'],
    ['!"lightning bolt"', ['bolt', 'bolt-ja']],
    ['!lightning', [], 'exact is not partial'],
    ['name:goyf', ['goyf']],
    ['name!=bolt t:instant', ['counter', 'fire-ice']],
    ['lim-dul', ['limdul'], 'accents fold'],
    ['ahnen', ['katana'], 'the printed name of a German copy'],
    // composition
    ['t:elf or t:goblin', ['elves']],
    ['(t:elf or t:instant) -c:r', ['counter', 'elves']],
    ['-(r:c or r:u)', ['dack', 'emrakul', 'goyf', 'jace', 'kenrith', 'limdul', 'reef', 'signet']],
    ['t:elf and c:g', ['elves']],
    ['c:r -is:foil', ['bolt-ja', 'dack', 'fire-ice']],
    ['t:instant c:u', ['counter', 'fire-ice'], 'an old row still answers from its type words and colours'],
    ['m:{U}{U}', ['jace'], 'an old row with no stored cost never matches'],
    ['t:creature unique:prints order:name', ['angel', 'bears', 'dack', 'delver', 'elves', 'emrakul', 'finks', 'goyf', 'kenrith', 'limdul'], 'directives never filter'],
    ['t:creature c:g cmc<=3 o:"draw a card" r:rare s:mh3 pow>=4 is:foil', []],
  ];
  for (const [q, want, why] of EXPECT) { assert.deepStrictEqual(ids(q), [...want].sort(), `${q}${why ? ` (${why})` : ''}`); checks++; }

  // ---- 6. What the stored rows cannot answer is an error at compile time —
  // before a single row is looked at — never a quietly empty result.
  const LOCAL_ERRORS = [
    ['otag:ramp', 'unsupportedKeyword', { keyword: 'otag:' }],
    ['f:edh', 'unsupportedKeyword', { keyword: 'f:' }],
    ['a:"rk post"', 'unsupportedKeyword', { keyword: 'a:' }],
    ['tix>1', 'unsupportedKeyword', { keyword: 'tix:' }],
    ['def:4', 'unsupportedKeyword', { keyword: 'def:' }],
    ['t:elf or otag:ramp', 'unsupportedKeyword', { keyword: 'otag:' }],
    ['is:reprint', 'unsupportedValue', { term: 'is:reprint' }],
    ['not:promo', 'unsupportedValue', { term: 'not:promo' }],
    ['name:/^light/', 'regexUnsupported', {}],
    ['/bolt/', 'regexUnsupported', {}],
    ['o:/draw/', 'regexUnsupported', {}],
    ['t>creature', 'unsupportedComparator', { keyword: 't', comparator: '>' }],
    ['s>lea', 'unsupportedComparator', { keyword: 's', comparator: '>' }],
    ['mv>even', 'unsupportedComparator', { keyword: 'mv', comparator: '>' }],
    ['cmc>=abc', 'invalidNumber', { term: 'cmc>=abc' }],
    ['pow>x', 'invalidNumber', { term: 'pow>x' }],
    ['cn>abc', 'invalidNumber', { term: 'cn>abc' }],
    ['usd>cheap', 'invalidNumber', { term: 'usd>cheap' }],
    ['c:yore', 'invalidColor', { value: 'yore' }],
    ['id:purple', 'invalidColor', { value: 'purple' }],
    ['r:legendary', 'invalidRarity', { value: 'legendary' }],
    ['m:hello', 'invalidMana', { value: 'hello' }],
    ['lang:klingon', 'invalidLanguage', { value: 'klingon' }],
  ];
  for (const [q, code, params] of LOCAL_ERRORS) {
    let caught = null;
    try { compileFilter(q, { languages: LANGUAGES }); } catch (err) { caught = err; }
    assert.ok(caught instanceof QuerySyntaxError, `${q} must not compile`);
    assert.strictEqual(caught.code, code, `${q} -> ${code}`);
    assert.deepStrictEqual(caught.params, params, `${q} params`);
    checks++;
  }
  assert.ok(/Unsupported/.test(new QuerySyntaxError('unsupportedKeyword', { keyword: 'otag:' }).message));
  // The parse alone accepts them: card search sends them on to Scryfall.
  for (const [q] of LOCAL_ERRORS.filter(([, code]) => code !== 'invalidLanguage')) assert.doesNotThrow(() => parseQuery(q), q);

  // ---- 7. Rows arriving straight from SQLite (JSON text for list columns) read
  // the same as parsed ones.
  const raw = { ...CARDS.find(c => c.id === 'angel'), types: '["White"]', color_identity: '["White"]', keywords: '["Flying","Vigilance"]', subtypes: '["Creature","Angel"]' };
  assert.strictEqual(compileFilter('c:w kw:flying t:angel', { languages: LANGUAGES })(raw), true);
  checks++;

  console.log(`scryfallquery.test.js: all ${checks} checks passed`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
