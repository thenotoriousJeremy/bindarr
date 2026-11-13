// One collection entry at a time: list, read, edit, price, delete. Adding lives
// in add.js, placement in placement.js, many-at-once in bulk.js.
const db = require('../../db');
const tcgdexApi = require('../../tcgdexApi');
const gradedPrices = require('../../gradedPrices');
const cardApi = require('../../utils/cardApi');
const { searchLimiter } = require('../../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../../utils/priceHelpers');
const { compartmentLabel, rebalanceCompartmentByScheme } = require('../../utils/compartmentSort');
const { checkedOutAllocation, resolveCompartmentAndPosition, describePlacement, setStackQuantity, setTileQuantity, tileMembers, ownedLocation, ownedCompartment } = require('../../utils/collectionHelpers');
const { readQuantity } = require('../../utils/requestBounds');
const { trashEntries } = require('../../utils/collectionTrash');
const { conflictingSealedLinks, GRADERS, CONDITIONS, PRINTINGS, ownsSealedUnit, cardIdForLanguage } = require('./shared');

// 2. Get User's Collection
//
// One row per physical entry, newest first. Two optional knobs exist for the
// collection grid, which at 20,000 rows spent seconds downloading and parsing a
// response it mostly did not draw:
//
//   fields=grid      only the columns a tile, the grid's filters and its sort
//                    read: no notes, slab cert, marketplace links, container
//                    labels or purchase details. The card popup asks for the
//                    full row when it opens (GET /collection/:id).
//   limit, offset    one page, with the unpaged total in X-Total-Count. Order is
//                    added_at DESC then id DESC, so rows added in the same second
//                    (a bulk add) still have one fixed order, and consecutive
//                    pages never repeat or skip a row.
//
// Without either, the response is what it always was: every row, every column.
// Storage, sealed and the deck builder all read it that way.
const COLLECTION_FULL_COLUMNS = `
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        c.grader,
        c.grade,
        c.cert_number,
        c.market_value,
        c.market_value_source,
        c.market_value_at,
        su.id AS sealed_unit_id,
        c.acquired_via_transfer_item_id,
        c.acquired_via_historical_trade_item_id,
        acquired_transfer.id AS acquired_transfer_id,
        acquired_transfer.transfer_type AS acquired_transfer_type,
        acquired_transfer.completed_at AS acquired_transfer_completed_at,
        transfer_partner.username AS acquired_transfer_partner,
        external_item.id AS acquired_external_transaction_item_id,
        external_transaction.id AS acquired_external_transaction_id,
        external_transaction.transaction_type AS acquired_external_transaction_type,
        external_transaction.contact_name_snapshot AS acquired_external_contact,
        external_transaction.completed_at AS acquired_external_completed_at,
        historical_trade.id AS acquired_historical_trade_id,
        historical_trade.completed_at AS acquired_historical_trade_completed_at,
        historical_partner.username AS acquired_historical_trade_partner,
        sp.id AS sealed_purchase_id,
        sp.product_id AS sealed_product_id,
        sp.product_name AS sealed_product_name,
        sp.set_name AS sealed_product_set_name,
        sp.sealed_type AS sealed_product_type,
        sp.game AS sealed_product_game,
        sp.image_url AS sealed_product_image_url,
        sp.store AS sealed_product_store,
        sp.purchase_date AS sealed_product_date,
        sp.unit_price AS sealed_product_unit_price,
        sp.quantity AS sealed_product_quantity,
        sp.notes AS sealed_product_notes,
        sp.expected_packs AS sealed_product_expected_packs,
        sp.expected_cards AS sealed_product_expected_cards,
        sp.contents_note AS sealed_product_contents_note,
        sp.market_value AS sealed_product_market_value,
        sp.market_value_source AS sealed_product_market_value_source,
        sp.market_value_at AS sealed_product_market_value_at,
        su.opened_at AS sealed_unit_opened_at,
        CASE WHEN su.id IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM sealed_units unit_order
          WHERE unit_order.purchase_id = su.purchase_id AND unit_order.id <= su.id) END AS sealed_unit_number,
        cc.name,
        -- The localized name for a non-English printing, so every view that
        -- renders a collection card can show it as the card actually reads.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url, cc.orientation, cc.attributes, cc.card_text, cc.artist,
        cc.image_url_back,
        -- Magic rules text, for filtering the collection in Scryfall syntax.
        cc.type_line,
        cc.oracle_text,
        cc.mana_cost,
        cc.power,
        cc.toughness,
        cc.loyalty,
        cc.keywords,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        cc.price_currency,
        cc.price_source,
        cc.game,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        cc.tcgplayer_product_id,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity`;

// What CollectionList draws, filters and sorts on. The sealed product's name,
// store and date stay because the "linked sealed purchase" filter labels its
// options with them. market_value and the per-printing prices are read only to
// resolve price_trend, and are dropped from the response afterwards.
const COLLECTION_GRID_COLUMNS = `
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.location_id,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.grader,
        c.grade,
        c.market_value,
        su.id AS sealed_unit_id,
        sp.product_name AS sealed_product_name,
        sp.store AS sealed_product_store,
        sp.purchase_date AS sealed_product_date,
        CASE WHEN su.id IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM sealed_units unit_order
          WHERE unit_order.purchase_id = su.purchase_id AND unit_order.id <= su.id) END AS sealed_unit_number,
        cc.name,
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        -- A Riftbound battlefield is drawn on its side (CardImage reads it).
        cc.orientation,
        cc.attributes,
        -- What the Scryfall-syntax search box matches the loaded rows against.
        cc.type_line,
        cc.oracle_text,
        cc.mana_cost,
        cc.power,
        cc.toughness,
        cc.loyalty,
        cc.keywords,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        cc.price_currency,
        cc.game`;
const GRID_PRICE_INPUTS = ['market_value', 'price_normal', 'price_holofoil', 'price_reverse_holofoil', 'price_1st_edition'];

// Owner-scoped: every write checks that a link names the user's own unit, but
// the read does not rely on that. A row pointing at another user's unit gets no
// sealed details at all, not that user's.
const COLLECTION_SEALED_JOINS = `
      LEFT JOIN sealed_units su ON su.id = c.sealed_unit_id
        AND EXISTS (SELECT 1 FROM sealed_purchases owner
                     WHERE owner.id = su.purchase_id AND owner.user_id = c.user_id)
      LEFT JOIN sealed_purchases sp ON sp.id = su.purchase_id AND sp.user_id = c.user_id`;

const COLLECTION_TRADE_JOINS = `
      LEFT JOIN user_transfer_items acquired_transfer_item
        ON acquired_transfer_item.id = c.acquired_via_transfer_item_id
       AND acquired_transfer_item.to_user_id = c.user_id
      LEFT JOIN user_transfers acquired_transfer
        ON acquired_transfer.id = acquired_transfer_item.transfer_id
      LEFT JOIN users transfer_partner
        ON transfer_partner.id = CASE
          WHEN acquired_transfer.proposer_id = c.user_id THEN acquired_transfer.recipient_id
          ELSE acquired_transfer.proposer_id
        END
      LEFT JOIN external_transaction_items external_item
        ON external_item.source_collection_id = c.id AND external_item.direction = 'received'
      LEFT JOIN external_transactions external_transaction
        ON external_transaction.id = external_item.transaction_id
       AND external_transaction.user_id = c.user_id
      LEFT JOIN historical_trade_items historical_trade_item
        ON historical_trade_item.id = c.acquired_via_historical_trade_item_id
       AND historical_trade_item.to_user_id = c.user_id
      LEFT JOIN historical_trades historical_trade
        ON historical_trade.id = historical_trade_item.trade_id
       AND historical_trade.status = 'confirmed'
      LEFT JOIN users historical_partner
        ON historical_partner.id = CASE
          WHEN historical_trade.creator_id = c.user_id THEN historical_trade.recipient_id
          ELSE historical_trade.creator_id
        END`;

const COLLECTION_PAGE_MAX = 5000;

function formatCollectionRows(rows, alloc, grid) {
  return rows.map(row => {
    const card = {
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
    };
    if (grid) {
      for (const key of GRID_PRICE_INPUTS) delete card[key];
      return card;
    }
    card.compartment_display_label = row.compartment_id
      ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
      : null;
    card.sub_location = row.compartment_id
      ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
      : '';
    return card;
  });
}

// A non-negative integer from the query string, the fallback when absent, and
// null for anything else (which the caller answers with a 400).
function readPagingInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function listCollection(req, res) {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;
    const game = req.query.game;
    const grid = req.query.fields === 'grid';
    if (req.query.fields !== undefined && !grid) {
      return res.status(400).json({ error: 'fields must be "grid" when given' });
    }

    const paged = req.query.limit !== undefined || req.query.offset !== undefined;
    const limit = readPagingInt(req.query.limit, COLLECTION_PAGE_MAX);
    const offset = readPagingInt(req.query.offset, 0);
    if (paged && (limit == null || limit < 1 || limit > COLLECTION_PAGE_MAX || offset == null)) {
      return res.status(400).json({ error: `limit must be 1-${COLLECTION_PAGE_MAX} and offset a non-negative integer` });
    }

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    const filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }
    // The deck builder has always sent ?game= and been handed every game back.
    // A card cached before multi-game support carries no game, and every one of
    // those is Pokémon, the same default the clients apply to item.game.
    if (game) {
      filterSql += ` AND COALESCE(cc.game, 'pokemon') = ?`;
      filterParams.push(String(game));
    }

    const query = `
      SELECT ${grid ? COLLECTION_GRID_COLUMNS : COLLECTION_FULL_COLUMNS}
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      ${grid ? '' : `LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id`}
      ${COLLECTION_SEALED_JOINS}
      ${grid ? '' : COLLECTION_TRADE_JOINS}
      ${filterSql}
      ORDER BY c.added_at DESC, c.id DESC
      ${paged ? 'LIMIT ? OFFSET ?' : ''}
    `;
    const rows = await db.all(query, paged ? [...filterParams, limit, offset] : filterParams);

    if (paged) {
      const counted = await db.get(
        `SELECT COUNT(*) AS n FROM collection c JOIN card_cache cc ON c.card_id = cc.id ${filterSql}`,
        filterParams
      );
      // Header, not the body: a page is still the bare array every caller reads.
      res.set('X-Total-Count', String(counted.n));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }

    const alloc = await checkedOutAllocation(req.user.id);
    res.json(formatCollectionRows(rows, alloc, grid));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
}

// 2a. One entry with every column: what the card popup shows when the grid it
// was opened from loaded only the grid's columns. A plain :id rather than
// Express's :id(\\d+), because the on-device router (embedded/router.js) has no
// inline patterns: anything not a number is passed on to whichever route owns
// that /collection/<word>.
async function getEntry(req, res, next) {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const row = await db.get(`
      SELECT ${COLLECTION_FULL_COLUMNS}
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${COLLECTION_SEALED_JOINS}
      ${COLLECTION_TRADE_JOINS}
      WHERE c.id = ? AND c.user_id = ?
    `, [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ error: 'Collection entry not found' });
    const alloc = await checkedOutAllocation(req.user.id);
    res.json(formatCollectionRows([row], alloc, false)[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection entry' });
  }
}

// 4. Update Collection Entry
async function updateEntry(req, res) {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, game, notes,
    grader, grade, cert_number, market_value, card_id, sealed_unit_id
  } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found', code: 'entry_not_found' });

    let isMoving = location_id !== undefined && location_id !== entry.location_id;
    let finalCompartmentId = entry.compartment_id;
    let finalLocationId = entry.location_id;
    let finalPosition = entry.position;
    let resolvedFull = false;
    let resolvedRejected = false;

    if (isMoving) {
      if (location_id === null || location_id === '') {
        finalLocationId = null;
        finalCompartmentId = null;
        finalPosition = 0;
      } else {
        if (!(await ownedLocation(location_id, req.user.id))) return res.status(404).json({ error: 'Location not found' });
        const resolved = await resolveCompartmentAndPosition({
          locationId: location_id,
          userId: req.user.id,
          cardId: entry.card_id,
          printing: printing !== undefined ? printing : entry.printing,
          language: language !== undefined ? language : entry.language
        });
        if (resolved.full) {
          // No room there. The copy stays where it is rather than being pulled
          // out of its slot into Unsorted; container_full says why it did not move.
          resolvedFull = true;
          isMoving = false;
        } else {
          finalCompartmentId = resolved.compartment_id;
          finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
          finalPosition = resolved.position;
          resolvedRejected = !!resolved.rejected;
        }
      }
    } else if (compartment_id !== undefined) {
      // Goes straight into the row, so it has to be one of the user's own
      // compartments — and the copy takes that compartment's container with it,
      // so location_id can never name a different one.
      const comp = compartment_id === null ? null : await ownedCompartment(compartment_id, req.user.id);
      if (compartment_id !== null && !comp) return res.status(404).json({ error: 'Compartment not found' });
      finalCompartmentId = comp ? comp.id : null;
      if (comp) finalLocationId = comp.location_id;
    }

    const updates = [];
    const params = [];

    // Absolute, not additive: see the reconcile below. Deliberately NOT part of
    // the UPDATE — the reconcile owns the quantity column so the two can
    // never disagree about how many copies the row stands for. Checked before
    // anything below writes: a bad number is refused, not rounded into range.
    const qty = readQuantity(quantity, { fallback: null });
    if (qty.error) return res.status(400).json({ error: qty.error });
    const requestedQty = qty.value;
    // The copies that number covers when it is a stacked tile's (see
    // tileMembers), taken from the row as it is now, before the edit changes it.
    const tile = requestedQty === null ? null : await tileMembers(db, req.user.id, entry, req.body.stack_entry_ids);
    if (tile && tile.error) return res.status(400).json({ error: tile.error });
    if (condition !== undefined && !CONDITIONS.includes(condition)) return res.status(400).json({ error: 'Invalid condition' });
    if (printing !== undefined && !PRINTINGS.includes(printing)) return res.status(400).json({ error: 'Invalid printing' });
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { updates.push('printing = ?'); params.push(printing); }
    if (language !== undefined) {
      updates.push('language = ?');
      params.push(language);
      if (language !== entry.language) {
        const cardId = await cardIdForLanguage(entry.card_id, language);
        if (cardId !== entry.card_id) {
          updates.push('card_id = ?');
          params.push(cardId);
        }
      }
    }
    // Re-file this copy under another printing of the SAME card: a scan or search
    // that found the right card in the wrong set. Same game and same name is the
    // whole invariant — anything else is a different card, which is a delete and
    // an add, not an edit. No merge with copies already on that printing: rows are
    // per copy, and identical rows are summed into one stack by every view, the
    // same way a language switch or a second add lands. Pushed after the language
    // block so an explicit printing wins over the implicit one (rightmost SET wins).
    let swappedCard = null;
    if (card_id !== undefined && card_id !== entry.card_id) {
      const target = String(card_id || '');
      const current = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [entry.card_id]);
      // Same lookup as an add: fill a thin cached row, else fetch and cache it.
      if (target) await cardApi.hydrate(target);
      let next = target && (await db.get(`SELECT * FROM card_cache WHERE id = ?`, [target]));
      if (target && !next) next = await cardApi.getCardById(target, { tcgApiKey: req.user.tcg_api_key });
      if (!next) return res.status(404).json({ error: `Card ID ${target} not found.`, code: 'card_not_found' });
      if ((next.game || cardApi.gameOf(next.id)) !== (entry.game || cardApi.gameOf(entry.card_id))) {
        return res.status(400).json({ error: 'A printing can only be changed to one from the same game.', code: 'printing_other_game' });
      }
      next = await tcgdexApi.learnEnglishName(next);
      const names = (c) => [c && c.name, c && c.printed_name].filter(Boolean).map(n => String(n).trim().toLowerCase());
      if (current && !names(next).some(n => names(current).includes(n))) {
        return res.status(400).json({ error: `${next.name} is a different card. Pick a printing of ${current.name}.` });
      }
      updates.push('card_id = ?');
      params.push(next.id);
      swappedCard = next;
    }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (sealed_unit_id !== undefined) {
      const unitId = sealed_unit_id == null || sealed_unit_id === '' ? null : Number(sealed_unit_id);
      if (unitId != null
          && (!Number.isInteger(unitId) || unitId < 1 || !(await ownsSealedUnit(unitId, req.user.id)))) {
        return res.status(404).json({ error: 'Sealed unit not found' });
      }
      if (unitId != null && unitId !== Number(entry.sealed_unit_id)) {
        const conflicts = await conflictingSealedLinks([id], req.user.id, unitId);
        if (conflicts.length) {
          const products = [...new Set(conflicts.map(row => row.product_name))].join(', ');
          return res.status(409).json({ error: `This card is already linked to another sealed product${products ? ` (${products})` : ''}. Unlink it first before linking to this one.` });
        }
      }
      updates.push('sealed_unit_id = ?');
      params.push(unitId);
    }
    if (isMoving || compartment_id !== undefined) {
      updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
      params.push(finalLocationId, finalCompartmentId, finalPosition);
    }
    if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (game !== undefined) { updates.push('game = ?'); params.push(game); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    // Grading. The three columns move together on purpose: sending grader:'Raw'
    // must clear the grade and cert in the same statement, or the row keeps a grade
    // it no longer claims to have. Cracking a slab is a real thing people do.
    if (grader !== undefined) {
      if (!GRADERS.includes(grader)) return res.status(400).json({ error: `Invalid grader. One of: ${GRADERS.join(', ')}` });
      const raw = grader === 'Raw';
      const g = raw || grade == null || grade === '' ? null : Number(grade);
      if (g != null && !(g > 0 && g <= 10)) return res.status(400).json({ error: 'grade must be between 0 and 10' });
      const cert = raw || !cert_number ? null : String(cert_number).trim();
      if (cert) {
        const dup = await db.get(
          `SELECT id FROM collection WHERE user_id = ? AND grader = ? AND cert_number = ? AND id != ?`,
          [req.user.id, grader, cert, id]
        );
        if (dup) return res.status(409).json({ error: `${grader} cert ${cert} is already in your collection.`, code: 'cert_in_use', params: { grader, cert } });
      }
      updates.push('grader = ?', 'grade = ?', 'cert_number = ?');
      params.push(grader, g, cert);
    }
    // What this copy is worth, typed by the owner. Empty string and null both mean
    // "drop it and go back to the provider price" — the field is a text input, and
    // clearing it has to be possible or a mistyped 10000 is permanent.
    if (market_value !== undefined) {
      if (market_value === null || market_value === '') {
        updates.push('market_value = ?', 'market_value_source = ?', 'market_value_at = ?');
        params.push(null, null, null);
      } else {
        const value = Number(market_value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ error: 'market_value must be a number of 0 or more', code: 'invalid_market_value' });
        }
        updates.push('market_value = ?', 'market_value_source = ?', "market_value_at = CURRENT_TIMESTAMP");
        params.push(value, 'manual');
      }
    }

    if (updates.length > 0) {
      params.push(id, req.user.id);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    if (isMoving && finalCompartmentId && finalLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
      if (loc) await rebalanceCompartmentByScheme(db, finalCompartmentId, loc.sort_order, loc.foil_sorting);
    }
    if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
      const oldLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
      if (oldLoc) await rebalanceCompartmentByScheme(db, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
    }
    // Same slot, new set and number: a binder sorted by set has to re-sort around it.
    if (swappedCard) {
      await recordPrice(swappedCard.id, swappedCard.price_trend);
      if (!isMoving && entry.compartment_id && entry.location_id) {
        const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
        if (loc) await rebalanceCompartmentByScheme(db, entry.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    // Quantity is absolute — it is how many copies the user says they own, and
    // in the stacked collection view the number in the form is the total across
    // the rows of the tile, not this row alone. So reconcile the whole stack to
    // it, up or down: the tile's rows when the popup named them, else the
    // identical rows. It used to only ever insert (quantity - 1) extra rows,
    // which made lowering the number a no-op and made every save duplicate the
    // entry instead of editing it.
    //
    // One transaction, so two saves of the same stack at once cannot both count
    // the copies before either has trimmed, and trim twice.
    let tileIds;
    if (requestedQty !== null) {
      const changed = await db.withTransaction(async () => {
        if (!tile) return setStackQuantity(db, req.user.id, id, requestedQty);
        const result = await setTileQuantity(db, req.user.id, id, requestedQty, tile.ids);
        tileIds = result.ids;
        return result.change;
      });
      if (changed !== 0) {
        const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row && row.compartment_id && row.location_id) {
          const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
          if (loc) await rebalanceCompartmentByScheme(db, row.compartment_id, loc.sort_order, loc.foil_sorting);
        }
      }
    }

    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected, stack_entry_ids: tileIds });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry', code: 'update_failed' });
  }
}

// 4a. Fetch this copy's graded value from the price provider and store it.
//
// Deliberately one entry per request and never automatic: the free tier of the
// only provider that publishes slab prices is metered per day, and a sweep over a
// collection would spend a week's allowance in one boot. The button is the budget.
async function fetchMarketValue(req, res) {
  try {
    const entry = await db.get(`
      SELECT c.id, c.grade, c.grader, cc.name, cc.set_name, cc.number, cc.game, cc.tcgplayer_product_id
      FROM collection c JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.id = ? AND c.user_id = ?`, [req.params.id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found', code: 'entry_not_found' });
    if (!entry.grader || entry.grader === 'Raw') {
      return res.status(400).json({ error: 'This copy is not graded. Graded prices apply to slabs only.' });
    }

    const result = await gradedPrices.fetchGradedPrice({
      game: entry.game,
      name: entry.name,
      setName: entry.set_name,
      number: entry.number,
      grader: entry.grader,
      grade: entry.grade,
      // The exact-card lookup: one card returned instead of a page of them, which
      // is the difference between 2 credits and a hundred.
      tcgPlayerId: entry.tcgplayer_product_id,
      apiKey: req.user.graded_price_api_key,
    });

    await db.run(
      `UPDATE collection SET market_value = ?, market_value_source = ?, market_value_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [result.price, result.source, req.params.id, req.user.id]
    );
    res.json({ market_value: result.price, source: result.source, basis: result.basis });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('graded price fetch failed:', error.message);
    res.status(status).json({ error: error.message || 'Failed to fetch graded price' });
  }
}

// 5. Delete Card from Collection
// Into the trash, so it can be undone (utils/collectionTrash.js). ?trash=0 skips
// the trash, for a client undoing its own add: that copy never existed as far as
// the user is concerned, and listing it in the trash would only be noise.
async function deleteEntry(req, res) {
  const { id } = req.params;
  try {
    if (req.query.trash === '0') {
      const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (result.changes === 0) return res.status(404).json({ error: 'Collection entry not found', code: 'entry_not_found' });
      return res.json({ message: 'Card removed from collection' });
    }
    const { batchId, trashed } = await trashEntries([id], req.user.id);
    if (trashed === 0) {
      return res.status(404).json({ error: 'Collection entry not found', code: 'entry_not_found' });
    }
    res.json({ message: 'Card removed from collection', trash_batch: batchId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card', code: 'delete_failed' });
  }
}

function register(router) {
  router.get('/collection', listCollection);
  router.get('/collection/:id', getEntry);
  router.put('/collection/:id', updateEntry);
  router.post('/collection/:id/market-value/fetch', searchLimiter, fetchMarketValue);
  router.delete('/collection/:id', deleteEntry);
}

module.exports = { register };
