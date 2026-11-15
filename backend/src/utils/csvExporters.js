const REVERSE_CONDITION_MAP = {
  dragonshield: { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'POOR' },
  manabox: { 'Near Mint': 'near_mint', 'Lightly Played': 'lightly_played', 'Moderately Played': 'moderately_played', 'Heavily Played': 'heavily_played', 'Damaged': 'damaged' }
};

const EXPORT_STRATEGIES = {
  internal: (item) => ({
    'Card ID': item.card_id,
    // csvMappers.internal has always read a Game column; this side never wrote
    // one, so a backup restored every Magic and Lorcana copy as Pokémon.
    'Game': item.game || '',
    'Name': item.name || item.card_name || '',
    'Set Name': item.set_name || '',
    'Set ID': item.set_id || item.set_code || '',
    'Card Number': item.collector_number || item.number || item.card_number || '',
    'Rarity': item.rarity || 'Common',
    'Quantity': item.quantity || 1,
    'Condition': item.condition || 'Near Mint',
    'Printing': item.printing || 'Normal',
    'Language': item.language || 'English',
    'Purchase Price': item.purchase_price || 0,
    'Market Price': item.price_trend || item.market_price || 0,
    'Location Container': item.location_name || 'Unassigned',
    'Sub-Location Page/Row': item.sub_location_1 || '',
    'Sub-Location Slot/Section': item.sub_location_2 || '',
    'Added At': item.added_at || ''
  }),
  tcgplayer: (item) => ({
    'Card Name': item.name || item.card_name || '',
    'Set Code': item.set_code || item.set_id || '',
    'Number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': item.condition || 'Near Mint',
    'Printing': item.printing === 'Holofoil' ? 'Foil' : 'Normal'
  }),
  dragonshield: (item) => ({
    'Card Name': item.name || item.card_name || '',
    'Set Code': item.set_code || item.set_id || '',
    'Card Number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': (REVERSE_CONDITION_MAP.dragonshield && REVERSE_CONDITION_MAP.dragonshield[item.condition]) || 'NM',
    'Printing': item.printing === 'Holofoil' ? 'Foil' : 'Normal'
  }),
  manabox: (item) => ({
    'Name': item.name || item.card_name || '',
    'Set code': item.set_code || item.set_id || '',
    'Card number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': (REVERSE_CONDITION_MAP.manabox && REVERSE_CONDITION_MAP.manabox[item.condition]) || 'near_mint',
    'Foil': item.printing === 'Holofoil' ? 'true' : 'false'
  })
};

// A spreadsheet reads a cell that starts with = + - @ (or a tab or carriage
// return, which some strip first) as a formula, and a formula can fetch URLs or
// run commands when the file is opened. Location names, card names and provider
// text all reach these cells, so a text value that starts that way is written
// with a leading apostrophe, which spreadsheets show as plain text. A plain number
// ("-5") is left alone, and csvMappers removes the apostrophe again when the file
// is imported back. OWASP's CSV-injection advice.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

function neutralizeCell(value) {
  if (typeof value !== 'string' || !FORMULA_START.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

function generateExportCSV(collectionItems, formatType = 'internal') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = EXPORT_STRATEGIES[formatKey] || EXPORT_STRATEGIES.internal;

  const mappedRows = collectionItems.map(strategy);
  if (mappedRows.length === 0) return '';

  const headers = Object.keys(mappedRows[0]);
  const csvRows = [headers.join(',')];

  for (const row of mappedRows) {
    const values = headers.map(header => {
      const val = row[header] !== undefined && row[header] !== null ? row[header] : '';
      return `"${String(neutralizeCell(val)).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

module.exports = {
  REVERSE_CONDITION_MAP,
  EXPORT_STRATEGIES,
  generateExportCSV,
  neutralizeCell
};
