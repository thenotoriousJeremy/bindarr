const express = require('express');
const db = require('../db');
const { authenticateToken, importLimiter } = require('../middleware/auth');
const { resolveCardPrice } = require('../utils/priceHelpers');
const { compartmentLabel } = require('../utils/compartmentSort');
const { resolveCompartmentAndPosition } = require('../utils/collectionHelpers');

const router = express.Router();
router.use(authenticateToken);

// 8. Export Database
router.get('/export', async (req, res) => {
  const { format = 'csv' } = req.query;
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
        cc.name as card_name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number as card_number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ?
    `;
    const dbRows = await db.all(query, [req.user.id]);
    const rows = dbRows.map(row => {
      const resolvedPrice = resolveCardPrice(row);
      return {
        ...row,
        market_price: resolvedPrice,
        compartment_display: row.compartment_idx ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type) : ''
      };
    });

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=bindarr_collection.json');
      return res.json(rows);
    }

    // Default to CSV
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=bindarr_collection.csv');

    // Headers
    const headers = [
      'Card ID', 'Name', 'Set Name', 'Set ID', 'Card Number', 'Rarity',
      'Quantity', 'Condition', 'Printing', 'Language', 'Purchase Price',
      'Market Price', 'Location Container', 'Compartment', 'Added At'
    ];

    // Neutralize leading =, +, -, @ so spreadsheet apps don't interpret free-text
    // fields (card/location names) as formulas when the export is opened.
    const csvCell = (value) => {
      const str = String(value ?? '');
      return /^[=+\-@]/.test(str) ? `'${str}` : str;
    };

    let csvContent = headers.join(',') + '\n';

    rows.forEach(r => {
      const line = [
        r.card_id,
        `"${csvCell(r.card_name).replace(/"/g, '""')}"`,
        `"${csvCell(r.set_name).replace(/"/g, '""')}"`,
        r.set_id,
        r.card_number,
        r.rarity,
        r.quantity,
        r.condition,
        r.printing,
        r.language,
        r.purchase_price || 0,
        r.market_price || 0,
        r.location_name ? `"${csvCell(r.location_name).replace(/"/g, '""')}"` : 'Unassigned',
        r.compartment_display ? `"${csvCell(r.compartment_display).replace(/"/g, '""')}"` : '',
        r.added_at
      ];
      csvContent += line.join(',') + '\n';
    });

    res.send(csvContent);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// 8b. Import Database
router.post('/import', importLimiter, async (req, res) => {
  try {
    const { format, data } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    let cards = [];

    if (format === 'json') {
      cards = typeof data === 'string' ? JSON.parse(data) : data;
    } else if (format === 'csv') {
      const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length <= 1) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }

      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

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

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;

        const cardObj = {};
        headers.forEach((header, idx) => {
          cardObj[header] = values[idx];
        });

        cards.push({
          card_id: cardObj['Card ID'],
          card_name: cardObj['Name'],
          set_name: cardObj['Set Name'],
          set_id: cardObj['Set ID'],
          card_number: cardObj['Card Number'],
          rarity: cardObj['Rarity'],
          quantity: parseInt(cardObj['Quantity']) || 1,
          condition: cardObj['Condition'] || 'Near Mint',
          printing: cardObj['Printing'] || 'Normal',
          language: cardObj['Language'] || 'English',
          purchase_price: parseFloat(cardObj['Purchase Price']) || 0,
          market_price: parseFloat(cardObj['Market Price']) || 0,
          location_name: cardObj['Location Container'],
          added_at: cardObj['Added At']
        });
      }
    }

    if (!Array.isArray(cards)) {
      return res.status(400).json({ error: 'Invalid data format. Expected an array or CSV lines.' });
    }

    // Bound the work: a 15mb body can hold tens of thousands of rows, and each
    // one does several serial SQL round-trips on the single-writer connection.
    // Cap it so one import can't stall the whole process.
    const MAX_IMPORT_ROWS = 5000;
    if (cards.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows (${cards.length}). Import at most ${MAX_IMPORT_ROWS} at a time.` });
    }

    // One transaction for the whole batch: a mid-loop failure rolls back
    // instead of leaving a half-imported collection behind.
    await db.run('BEGIN IMMEDIATE');
    let importedCount = 0;
    for (const card of cards) {
      const cardId = card.card_id || card.id;
      if (!cardId) continue;

      // 1. Ensure the card is in the cache. card_cache is shared across all
      // users, so never trust client-supplied metadata beyond a sanitized
      // placeholder. Bulk import does NOT call the external API per card — a
      // large import would otherwise fire thousands of serial requests and
      // exhaust the TCG API rate limit. Real metadata/prices fill in later via
      // the background price updater and the next per-card lookup.
      let cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
      if (!cached) {
        const safeTypes = Array.isArray(card.types) ? JSON.stringify(card.types.filter(t => typeof t === 'string')) : '[]';
        const safePrice = Number.isFinite(Number(card.market_price || card.price_trend)) ? Math.max(0, Number(card.market_price || card.price_trend)) : 0;
        await db.run(
          `INSERT OR IGNORE INTO card_cache
           (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            cardId,
            String(card.card_name || 'Imported Card').slice(0, 200),
            String(card.supertype || 'Pokémon').slice(0, 50),
            '[]',
            safeTypes,
            String(card.rarity || 'Common').slice(0, 50),
            String(card.set_id || '').slice(0, 50),
            String(card.set_name || 'Imported Set').slice(0, 200),
            String(card.card_number || card.number || '').slice(0, 20),
            '',
            safePrice
          ]
        );
      }

      // 2. Resolve location_id from location_name, scoped to this user only.
      // The exported "Compartment" column is a display label, not a stable
      // identifier — the sort assistant re-picks a real compartment on
      // import rather than trying to parse a page/row number back out of it.
      let locationId = null;
      const locName = card.location_name || card.location_container;
      if (locName && locName !== 'Unassigned') {
        let locRow = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [locName, req.user.id]);
        if (!locRow) {
          const newLoc = await db.run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [locName, 'Other', req.user.id]);
          await db.createCompartments(newLoc.lastID, 1, 1000);
          locationId = newLoc.lastID;
        } else {
          locationId = locRow.id;
        }
      }

      const resolved = await resolveCompartmentAndPosition({
        locationId, compartmentId: null, position: undefined, userId: req.user.id, cardId, printing: card.printing || 'Normal', language: card.language || 'English'
      });

      // 3. Insert card into the collection
      await db.run(
        `INSERT INTO collection
         (card_id, user_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cardId,
          req.user.id,
          card.quantity || 1,
          card.condition || 'Near Mint',
          card.printing || 'Normal',
          card.language || 'English',
          card.purchase_price || 0,
          locationId,
          resolved.compartment_id,
          resolved.position,
          card.added_at || new Date().toISOString()
        ]
      );
      importedCount++;
    }

    await db.run('COMMIT');
    res.json({ success: true, message: `Successfully imported ${importedCount} cards.` });
  } catch (error) {
    console.error('Import failed:', error);
    // Roll back the partial batch. Ignore rollback errors (e.g. no active tx if
    // we failed before BEGIN) so the real error is what surfaces.
    await db.run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
