import sys

with open('backend/src/tcgApi.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """// Save a list of cards to SQLite cache"""

replacement = """// Fetch and cache all sets
async function fetchAndCacheSets() {
  try {
    const existingSets = await db.get('SELECT COUNT(*) as count FROM sets');
    if (existingSets && existingSets.count > 0) {
      console.log(`Sets table already populated (${existingSets.count} sets). Skipping fetch.`);
      return;
    }
    
    console.log('Fetching sets from Pokemon TCG API...');
    let sets = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const response = await tcgClient.get(`/sets`, { params: { page, pageSize: 250 } });
      const data = response.data.data;
      if (data && data.length > 0) {
        sets = sets.concat(data);
        page++;
      } else {
        hasMore = false;
      }
    }
    
    console.log(`Fetched ${sets.length} sets. Saving to database...`);
    
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id,
          s.name,
          s.series || '',
          s.printedTotal || 0,
          s.total || 0,
          s.releaseDate || '',
          s.ptcgoCode || '',
          s.images ? s.images.symbol : '',
          s.images ? s.images.logo : ''
        ]
      );
    }
    console.log('Sets successfully cached.');
  } catch (error) {
    console.error('Error fetching sets:', error.message);
  }
}

// Save a list of cards to SQLite cache"""

if target in content:
    content = content.replace(target, replacement)
    
    # Also add fetchAndCacheSets to module.exports
    export_target = """module.exports = {
  searchCards,
  getCardByExactId,
  updateCollectionPrices
};"""
    export_replacement = """module.exports = {
  searchCards,
  getCardByExactId,
  updateCollectionPrices,
  fetchAndCacheSets
};"""
    if export_target in content:
        content = content.replace(export_target, export_replacement)
        print("Exported fetchAndCacheSets")
    else:
        print("Warning: export target not found")
        
    with open('backend/src/tcgApi.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Added fetchAndCacheSets to tcgApi.js")
else:
    print("Target not found in tcgApi.js")
