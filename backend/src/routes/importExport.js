const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseThirdPartyCSV, parseManaboxText } = require('../utils/csvMappers');
const scryfallApi = require('../scryfallApi');
const lorcastApi = require('../lorcastApi');
const { generateExportCSV } = require('../utils/csvExporters');
const { resolveCardPrice } = require('../utils/priceHelpers');
const { isBinderType } = require('../utils/compartmentSort');
const cardApi = require('../utils/cardApi');
const pokemonProvider = require('../utils/pokemonProvider');
const languages = require('../utils/languages');
const { matcher, normName } = require('../utils/setCatalogueMatch');
const { importLimiter } = require('../middleware/auth');

// Every row can cost a provider lookup and the whole file is written in one
// transaction, so a file has to be bounded. Bigger collections import in parts.
const MAX_IMPORT_ROWS = 5000;
const tooManyRows = (res, count) => res.status(413).json({
  error: `Too many rows (${count}). Import at most ${MAX_IMPORT_ROWS} at a time.`
});

// Turn an imported row into a card that is really in card_cache, or null.
//
// This used to mint an id from the row itself — `<set>-<number>`, or the name as
// a slug when no set/number columns were found — and insert a placeholder
// card_cache row with no image and the file's price. No provider ever saw it, so
// the card showed blank art and $0.00 forever, and the TCGCSV sweep, which prices
// by set and number, skipped it (#75). A row is now imported only when the
// provider that minted its id, or the configured Pokémon provider by set and
// number, actually has the card. A name alone is never enough: it names every
// printing of the card.
async function resolveImportedCard(item, user, setsFor) {
  const game = item.game || 'pokemon';
  const id = item.card_id || item.id;
  if (id) {
    if (await db.get(`SELECT id FROM card_cache WHERE id = ?`, [id])) return id;
    const card = await cardApi.getCardById(id, { game, tcgApiKey: user.tcg_api_key }).catch(() => null);
    if (card) return card.id;
  }

  const number = String(item.collector_number || item.number || '').split('/')[0].trim();
  const set = item.set_code || item.set_id || item.set_name;
  // MTG set+number rows were already asked of Scryfall in one batch (see the
  // route); one that reaches here is a printing Scryfall does not have.
  if (game === 'mtg' || !number || !set) return null;

  if (game === 'lorcana') {
    const { cards } = await lorcastApi.searchCards({ set, number, limit: 250 });
    return pick(cards, item.name);
  }

  const lang = languages.toCode(item.language || 'English');
  const api = await pokemonProvider.apiFor(lang);
  // The file's set column, as the provider that will be asked numbers it: a
  // pokemontcg.io export says sv1 where TCGdex says sv01, and many apps write the
  // set NAME there instead of any code.
  const setRow = (await setsFor(api, lang))(set, item.set_name || set);
  if (!setRow) return null;
  const { cards } = await api.searchCards({ set: setRow.id, number, lang, apiKey: user.tcg_api_key, limit: 250 });
  return pick(cards, item.name);
}

// The one card a set+number search means: the only result, or the only one with
// the row's name. Anything else is ambiguous and is not guessed at.
function pick(cards = [], name) {
  const named = cards.filter(c => normName(c.name) === normName(name));
  const card = named.length === 1 ? named[0] : (cards.length === 1 ? cards[0] : null);
  return card ? card.id : null;
}

// Rows that name the same printing are resolved once.
const importKey = (item) => JSON.stringify([item.card_id || item.id, item.game, item.set_code || item.set_id,
  item.set_name, item.collector_number || item.number, item.language, item.name]);

// Export endpoint
router.get('/export', async (req, res) => {
  const { format = 'csv', ecosystem = 'internal' } = req.query;
  const targetFormat = (ecosystem || format || 'internal').toLowerCase();

  try {
    const query = `
      SELECT 
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.added_at,
        cc.id as card_id,
        cc.name as name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id as set_code,
        cc.set_name,
        cc.number as collector_number,
        cc.image_url,
        c.grader,
        c.grade,
        c.market_value,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        c.position
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ?
    `;
    const raw = await db.all(query, [req.user.id]);
    // market_price used to be cc.price_trend flat, which exported the wrong number
    // for every foil, every 1st Edition and every slab — the same three cases
    // resolveCardPrice exists to get right. An export that disagrees with the
    // dashboard is worse than no export: it is a spreadsheet someone will trust.
    // price_trend is destructured OUT along with the per-printing columns: the CSV
    // strategies read `item.price_trend || item.market_price`, so leaving it in
    // would win over the resolved number and export the raw price anyway.
    const rows = raw.map(({ price_trend, price_normal, price_holofoil, price_reverse_holofoil, price_1st_edition, ...keep }) => ({
      ...keep,
      market_price: resolveCardPrice({ price_trend, price_normal, price_holofoil, price_reverse_holofoil, price_1st_edition, ...keep }),
      // The two sub-location columns the exporters read. They used to be selected
      // straight off the collection table as sub_location_1/2 — columns db.js has
      // DROPPED the table to remove, so every export answered
      // "no such column: c.sub_location_1" and 500'd. Rebuilt from the compartment
      // the card actually lives in, the same way the collection view labels it.
      sub_location_1: keep.compartment_idx == null
        ? ''
        : (keep.compartment_label || `${isBinderType(keep.location_type) ? 'Page' : 'Row'} ${keep.compartment_idx}`),
      sub_location_2: keep.position >= 1000 ? String(Math.floor(keep.position / 1000)) : '',
    }));

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=pokedexrr_collection_${targetFormat}.json`);
      return res.json(rows);
    }

    const csvContent = generateExportCSV(rows, targetFormat);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=pokedexrr_collection_${targetFormat}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// Import endpoint
router.post('/import', importLimiter, async (req, res) => {
  const { format = 'internal', data } = req.body;
  if (!data) {
    return res.status(400).json({ error: 'No data provided' });
  }

  try {
    let rawItems = [];
    let unmatchedCount = 0;
    const formatKey = format.toLowerCase();
    if (formatKey === 'json') {
      rawItems = typeof data === 'string' ? JSON.parse(data) : data;
    } else if (formatKey === 'manabox') {
      rawItems = parseManaboxText(data);
      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'No ManaBox cards found' });
      }
      if (rawItems.length > MAX_IMPORT_ROWS) return tooManyRows(res, rawItems.length);

      const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(rawItems.map(item => ({
        ...item,
        set_id: item.set_code,
        number: item.collector_number
      })));
      await scryfallApi.cacheCards(cards);

      unmatchedCount = rawItems.length - pairs.length;
      rawItems = pairs.map(({ row, card }) => ({ ...row, card_id: card.id }));
      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'No ManaBox cards matched Scryfall' });
      }
    } else {
      let lines = [];
      if (typeof data === 'string') {
        lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      }
      if (lines.length <= 1) {
        return res.status(400).json({ error: 'CSV file is empty or missing headers' });
      }

      const parseCSVLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };

      const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
      const parsedRows = [];

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]).map(v => v.replace(/^"|"$/g, ''));
        if (values.length < headers.length) continue;

        const rowObj = {};
        headers.forEach((h, idx) => {
          rowObj[h] = values[idx];
        });
        parsedRows.push(rowObj);
      }

      rawItems = parseThirdPartyCSV(parsedRows, format);
    }

    if (!Array.isArray(rawItems)) {
      return res.status(400).json({ error: 'Invalid data payload' });
    }
    if (rawItems.length > MAX_IMPORT_ROWS) return tooManyRows(res, rawItems.length);

    // Resolved before the transaction, not inside it: resolving can mean a
    // provider request per row, and a write transaction must not wait on the
    // network. Identical rows are asked about once.
    // ponytail: sequential, one lookup per distinct printing; bounded concurrency
    // if large imports prove too slow.
    const setMatchers = new Map();
    const setsFor = async (api, lang) => {
      if (!setMatchers.has(lang)) {
        // The provider's own set list, so the id handed back is one its search
        // understands. pokemontcg.io has no listing; it fills `sets` instead.
        const sets = await api.listSets(lang)
          .catch(() => db.all(`SELECT id, name FROM sets WHERE game = 'pokemon'`));
        setMatchers.set(lang, matcher(sets));
      }
      return setMatchers.get(lang);
    };
    const resolved = new Map();

    // MTG set+number rows (Moxfield, Deckbox, Archidekt exports) go to Scryfall's
    // collection endpoint 75 at a time, so a large file costs a few requests
    // rather than one per row. Rows already cached (a ManaBox import, a backup)
    // are skipped; a failure leaves the rows to be reported as unresolved.
    const mtgRows = [];
    for (const item of rawItems) {
      const id = item.card_id || item.id;
      const set = item.set_code || item.set_id;
      const number = String(item.collector_number || item.number || '').trim().replace(/^0+(?=\d)/, '');
      if (item.game !== 'mtg' || !set || !number) continue;
      if (id && await db.get(`SELECT id FROM card_cache WHERE id = ?`, [id])) continue;
      mtgRows.push({ ...item, set_id: set, number, key: importKey(item) });
    }
    if (mtgRows.length) {
      try {
        const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(mtgRows);
        await scryfallApi.cacheCards(cards);
        for (const { row, card } of pairs) resolved.set(row.key, card.id);
      } catch (e) {
        console.warn(`Import: Scryfall lookup failed: ${e.message}`);
      }
    }

    const toImport = [];
    const unresolved = [];
    for (const item of rawItems) {
      const key = importKey(item);
      if (!resolved.has(key)) {
        resolved.set(key, await resolveImportedCard(item, req.user, setsFor).catch((e) => {
          console.warn(`Import: could not resolve ${item.name || item.card_id}: ${e.message}`);
          return null;
        }));
      }
      const cardId = resolved.get(key);
      if (cardId) toImport.push({ item, cardId });
      else unresolved.push({
        name: item.name || '',
        set: item.set_code || item.set_id || item.set_name || '',
        number: item.collector_number || item.number || '',
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
      });
    }

    if (toImport.length === 0) {
      return res.status(400).json({
        error: 'None of the rows could be matched to a card. Each row needs a set and a card number (or a Bindarr card ID).',
        unresolved,
      });
    }

    let importedCount = 0;

    await db.withTransaction(async () => {
      for (const { item, cardId } of toImport) {
        // A copy is a row, never a quantity on one row: a stacked row cannot be
        // filed into separate slots or lent to a deck one copy at a time (#64).
        // Backups and third-party CSVs still carry a quantity column, so expand
        // it here, the same way POST /collection does.
        const copies = Math.max(1, parseInt(item.quantity, 10) || 1);
        for (let i = 0; i < copies; i++) {
          await db.run(
            `INSERT INTO collection
             (card_id, user_id, quantity, condition, printing, language, purchase_price, game, added_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              cardId,
              req.user.id,
              item.condition || 'Near Mint',
              item.printing || 'Normal',
              item.language || 'English',
              item.purchase_price || 0,
              item.game || 'pokemon'
            ]
          );
          importedCount++;
        }
      }
    });

    const unmatched = unmatchedCount ? ` ${unmatchedCount} unmatched ManaBox printings were skipped.` : '';
    // Named, not just counted: the list is what lets the user fix the file.
    const examples = unresolved.slice(0, 5).map(r => [r.name, r.set, r.number && `#${r.number}`].filter(Boolean).join(' ')).join(', ');
    const skipped = unresolved.length
      ? ` ${unresolved.length} row${unresolved.length === 1 ? '' : 's'} could not be matched to a card and ${unresolved.length === 1 ? 'was' : 'were'} skipped (${examples}${unresolved.length > 5 ? ', …' : ''}). Check their set and card number, then import them again.`
      : '';
    return res.json({ success: true, count: importedCount, unresolved, message: `Successfully imported ${importedCount} items.${unmatched}${skipped}` });
  } catch (error) {
    return res.status(500).json({ error: 'Import failed', message: error.message });
  }
});

// Build a physical box from matching, unfiled cards the user already owns.
router.post('/import-container', importLimiter, async (req, res) => {
  const { data, name } = req.body;
  const containerName = String(name || '').trim();
  if (!data || !containerName) {
    return res.status(400).json({ error: 'Container name and ManaBox data are required' });
  }

  try {
    const items = parseManaboxText(data);
    if (items.length === 0) return res.status(400).json({ error: 'No ManaBox cards found' });
    if (items.length > MAX_IMPORT_ROWS) return tooManyRows(res, items.length);
    const duplicate = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [containerName, req.user.id]);
    if (duplicate) return res.status(400).json({ error: 'A location with this name already exists' });

    const { pairs } = await scryfallApi.bulkFetchByIdentifier(items.map(item => ({
      ...item,
      set_id: item.set_code,
      number: item.collector_number
    })));
    if (pairs.length === 0) return res.status(400).json({ error: 'No ManaBox cards matched Scryfall' });

    const requested = pairs.reduce((total, { row }) => total + row.quantity, 0);
    let locationId;
    let count = 0;
    await db.withTransaction(async () => {
      const entries = [];
      for (const { row, card } of pairs) {
        let remaining = row.quantity;
        const owned = await db.all(`
          SELECT id FROM collection
          WHERE user_id = ? AND card_id = ? AND printing = ? AND list_type = 'collection'
            AND location_id IS NULL AND quantity = 1
          ORDER BY id
          LIMIT ?
        `, [req.user.id, card.id, row.printing || 'Normal', remaining]);
        for (const entry of owned) {
          entries.push(entry.id);
          remaining--;
        }
      }

      count = entries.length;
      const location = await db.run(`
        INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, game, user_id)
        VALUES (?, 'Box', 'custom', 'normals_first', 'any', 'mtg', ?)
      `, [containerName, req.user.id]);
      locationId = location.lastID;
      const compartment = await db.run(
        `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, ?)`,
        [locationId, Math.max(1, count)]
      );

      for (let index = 0; index < entries.length; index++) {
        await db.run(
          `UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [locationId, compartment.lastID, (index + 1) * 1000, entries[index], req.user.id]
        );
      }
    });

    const missing = requested - count;
    const skipped = missing ? ` ${missing} card${missing === 1 ? '' : 's'} not found in Unsorted.` : '';
    res.status(201).json({ id: locationId, count, missing, message: `Created ${containerName} with ${count} cards.${skipped}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to import container' });
  }
});

module.exports = router;
