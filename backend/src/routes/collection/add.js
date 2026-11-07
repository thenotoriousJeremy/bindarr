// Adding cards. addCardToCollection is the one path every add takes — the
// single add, the bulk add, and the sealed-unit opener in routes/sealed.js —
// so one card and two hundred travel exactly the same way.
const db = require('../../db');
const tcgdexApi = require('../../tcgdexApi');
const cardApi = require('../../utils/cardApi');
const games = require('../../utils/games');
const { recordPrice } = require('../../utils/priceHelpers');
const { rebalanceCompartmentByScheme } = require('../../utils/compartmentSort');
const { resolveCompartmentAndPosition, describePlacement } = require('../../utils/collectionHelpers');
const { readQuantity } = require('../../utils/requestBounds');
const { AddCardError, GRADERS, ownsSealedUnit } = require('./shared');

// The provider-facing half of an add: hydrate a thin cached row, fetch an
// uncached card, swap to the printing in `language`, learn its English name.
// Every one of these may make an HTTP request, so a caller that adds cards
// inside a write transaction (opening a sealed unit) runs this first, outside
// the transaction, and passes the result in as `resolvedCard`.
async function resolveCardForAdd(user, { card_id, game = 'pokemon', language = 'English' }) {
  if (!card_id) throw new AddCardError(400, 'card_id is required');
  // A card matched by a set-scoped scan was cached from a TCGdex set brief:
  // name, number and art only. Fill it in before it enters the collection, or it
  // is stored with no price, no marketplace link and a defaulted rarity — which
  // is what it then shows in the inspector forever.
  await cardApi.hydrate(card_id);

  let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
  if (!card) {
    card = await cardApi.getCardById(card_id, { game, tcgApiKey: user.tcg_api_key });
    if (!card) {
      throw new AddCardError(404, `Card ID ${card_id} not found.`, 'card_not_found');
    }
  }

  // File the copy against the printing it actually IS. The card was picked in
  // whatever language the search ran in, but `language` is set separately — Quick
  // Add's dropdown, a scan the English catalog answered — so a Japanese copy
  // routinely arrived pointing at the English row, and then showed the English
  // name, art and price in every view. Null (never printed in that language, or a
  // pokemontcg.io id that cannot be localized) keeps the row that was picked.
  let cardId = card_id;
  const localized = await cardApi.printingInLanguage(card, language);
  if (localized) {
    card = localized;
    cardId = localized.id;
  }
  // A localized row can be short an English name (TCGdex publishes only one name
  // per language). Learn it here so the collection stays searchable in English
  // while displaying the name the card is actually printed with.
  card = await tcgdexApi.learnEnglishName(card);
  return { card, cardId };
}

async function addCardToCollection(user, body, { resolvedCard = null } = {}) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    game = 'pokemon',
    stackable = false,
    grader = 'Raw',
    grade = null,
    cert_number = null,
    sealed_unit_id = null
  } = body;
  const req = { user, body };

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }
  const qty = readQuantity(quantity);
  if (qty.error) throw new AddCardError(400, qty.error);

  // Grading, validated here rather than at the two call sites, so the single add
  // and the bulk add cannot disagree about what a slab is.
  if (!GRADERS.includes(grader)) {
    throw new AddCardError(400, `Invalid grader. One of: ${GRADERS.join(', ')}`);
  }
  const gradeNum = grade == null || grade === '' ? null : Number(grade);
  if (gradeNum != null && !(gradeNum > 0 && gradeNum <= 10)) {
    throw new AddCardError(400, 'grade must be between 0 and 10');
  }
  const cert = cert_number ? String(cert_number).trim() : null;
  // A raw card has no grade and no cert by definition. Silently keeping either
  // would leave a row that reads as raw in one column and graded in another, and
  // every downstream check would then depend on which column it happened to read.
  const isGraded = grader !== 'Raw';
  const certValue = isGraded ? cert : null;
  const gradeValue = isGraded ? gradeNum : null;

  // Checked before the insert purely for the message: the unique index in db.js is
  // what actually enforces this, and still catches a race between two requests.
  // Without the check the user gets 'Failed to add card' and no idea why.
  if (certValue) {
    const dup = await db.get(
      `SELECT c.id, cc.name FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.grader = ? AND c.cert_number = ?`,
      [user.id, grader, certValue]
    );
    if (dup) {
      throw new AddCardError(409, `${grader} cert ${certValue} is already in your collection as ${dup.name}.`, 'cert_in_use', { grader, cert: certValue, name: dup.name });
    }
  }

  // Ownership before anything is fetched or written: the unit must be this
  // user's, or the link would expose another user's purchase through
  // GET /collection. 404, like any other id the user cannot see.
  const sealedUnitId = sealed_unit_id == null || sealed_unit_id === '' ? null : Number(sealed_unit_id);
  if (sealedUnitId != null
      && (!Number.isInteger(sealedUnitId) || sealedUnitId < 1 || !(await ownsSealedUnit(sealedUnitId, user.id)))) {
    throw new AddCardError(404, 'Sealed unit not found');
  }

  {
    const { card, cardId } = resolvedCard || await resolveCardForAdd(user, { card_id, game, language });

    // The card's own game, not the request's: the request used to win whenever it
    // named anything but Pokémon, so a client could file a Pokémon card as Magic.
    // It is only a fallback for a row that carries no game, and only for a game
    // the id does not contradict.
    const effectiveGame = (games.isGame(card.game) ? card.game : null)
      || cardApi.gameOf(cardId, req.body.game)
      || games.LEGACY_GAME;

    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        throw new AddCardError(400, 'Invalid location ID');
      }
    }

    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id,
      userId: req.user.id,
      cardId,
      printing,
      language
    });

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    let lastInsertedId = null;
    const insertedIds = [];
    // A cert number names ONE physical slab, so a quantity above 1 is not a
    // request for more of them — it is a mistake that the per-user unique index on
    // (grader, cert_number) would reject on the second insert anyway, after the
    // first had already been written. Collapse it here so the request succeeds with
    // the row the user actually meant.
    const count = certValue ? 1 : qty.value;
    // Stacking is quantity-on-one-row, which is meaningful only for interchangeable
    // copies. Two slabs are never interchangeable: they have different certs, and
    // usually different grades.
    const stack = stackable && !isGraded;

    if (stack) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, list_type, game,
          grader, grade, cert_number, sealed_unit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cardId, req.user.id, count, condition, printing, language, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type, effectiveGame,
        grader, gradeValue, certValue, sealedUnitId
      ]);
      lastInsertedId = result.lastID;
      insertedIds.push(lastInsertedId);
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, is_trade, list_type, game,
            grader, grade, cert_number, sealed_unit_id
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cardId, req.user.id, condition, printing, language, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type, effectiveGame,
          grader, gradeValue, certValue, sealedUnitId
        ]);
        lastInsertedId = result.lastID;
        insertedIds.push(lastInsertedId);
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    await recordPrice(cardId, card.price_trend);

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      // All rows created by this request, so a caller that added N copies can
      // undo/manage each one individually rather than only the last insert.
      ids: insertedIds,
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    };
  }
}

// 3. Add Card to Collection
async function addCard(req, res) {
  try {
    res.status(200).json(await addCardToCollection(req.user, req.body));
  } catch (error) {
    if (error instanceof AddCardError) {
      return res.status(error.status).json({ error: error.message, code: error.code, params: error.params });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card', code: 'add_failed' });
  }
}

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
const BULK_ADD_MAX_COPIES = 10 * BULK_ADD_MAX;
async function bulkAdd(req, res) {
  const { card_ids = [], ...shared } = req.body;
  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: 'card_ids is required' });
  }
  if (card_ids.length > BULK_ADD_MAX) {
    return res.status(400).json({ error: `Cannot add more than ${BULK_ADD_MAX} cards at once.` });
  }
  // Every field in `shared` is applied to every card, which a cert number cannot
  // survive: it identifies one slab. Rejected rather than dropped, because silently
  // discarding it would add the cards ungraded and look like it worked.
  if (shared.cert_number) {
    return res.status(400).json({ error: 'A certification number applies to a single card. Add graded cards one at a time.' });
  }
  // Checked once here rather than failing every card the same way, and with the
  // product bounded too: 250 cards at 9,999 each is 2.5 million rows.
  const qty = readQuantity(shared.quantity, { fallback: 1 });
  if (qty.error) return res.status(400).json({ error: qty.error });
  if (card_ids.length * qty.value > BULK_ADD_MAX_COPIES) {
    return res.status(400).json({ error: `That is ${card_ids.length * qty.value} copies. Add at most ${BULK_ADD_MAX_COPIES} at once.` });
  }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError)) console.error(error);
      failed.push({ card_id, error: error instanceof AddCardError ? error.message : 'Failed to add card' });
    }
  }
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty.value > 1 ? ` (x${qty.value} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
}

function register(router) {
  router.post('/collection', addCard);
  router.post('/collection/bulk-add', bulkAdd);
}

module.exports = { register, addCardToCollection, resolveCardForAdd };
