const CONDITION_MAP = {
  'near mint': 'Near Mint', 'nm': 'Near Mint', 'near_mint': 'Near Mint',
  'lightly played': 'Lightly Played', 'lp': 'Lightly Played', 'lightly_played': 'Lightly Played',
  'moderately played': 'Moderately Played', 'mp': 'Moderately Played',
  'heavily played': 'Heavily Played', 'hp': 'Heavily Played',
  'damaged': 'Damaged', 'dmg': 'Damaged', 'poor': 'Damaged'
};

const STRATEGIES = {
  internal: (row) => ({
    name: row['Name'] || row['card_name'] || row['Name'],
    set_code: row['Set ID'] || row['set_code'] || row['Set Code'],
    set_name: row['Set Name'] || row['set_name'],
    collector_number: row['Card Number'] || row['card_number'] || row['number'],
    card_id: row['Card ID'] || row['card_id'],
    quantity: parseInt(row['Quantity'] || row['quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: row['Printing'] || 'Normal',
    language: row['Language'] || 'English',
    purchase_price: parseFloat(row['Purchase Price'] || row['purchase_price']) || 0,
    game: row['Game'] || row['game'] || 'pokemon'
  }),
  tcgplayer: (row) => ({
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number: row['Number'] || row['Card Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Printing'] === 'Foil' || row['Printing'] === 'Holofoil') ? 'Holofoil' : 'Normal',
    game: 'pokemon'
  }),
  dragonshield: (row) => ({
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number: row['Card Number'] || row['Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Printing'] === 'Foil' || row['Printing'] === 'Holofoil') ? 'Holofoil' : 'Normal',
    game: 'pokemon'
  }),
  manabox: (row) => ({
    name: row['Name'] || row['Card Name'],
    set_code: row['Set code'] || row['Set Code'] || row['Set'],
    collector_number: row['Card number'] || row['Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Foil'] === 'true' || row['Foil'] === '1' || row['Foil'] === true) ? 'Holofoil' : 'Normal',
    game: 'mtg'
  })
};

function parseThirdPartyCSV(rows, formatType = 'tcgplayer') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = STRATEGIES[formatKey] || STRATEGIES.internal;
  return rows.map(strategy);
}

module.exports = {
  CONDITION_MAP,
  STRATEGIES,
  parseThirdPartyCSV
};
