import { getActiveLocale } from './translate.js';

// What to show for a failed API call. Server errors carry an English `error`
// (for logs, scripts and older clients) and, for the ones a user commonly meets,
// a stable `code` plus any `params` its sentence needs. A known code is shown in
// the interface language; an unknown one falls back to the server's own words,
// and a body with neither to the caller's message.
const KEYS = {
  card_not_found: 'apiError.cardNotFound',
  cert_in_use: (p) => (p && p.name ? 'apiError.certInUseAs' : 'apiError.certInUse'),
  add_failed: 'apiError.addFailed',
  entry_not_found: 'apiError.entryNotFound',
  printing_other_game: 'apiError.printingOtherGame',
  invalid_market_value: 'apiError.invalidMarketValue',
  invalid_added_at: 'apiError.invalidAddedAt',
  update_failed: 'apiError.updateFailed',
  delete_failed: 'apiError.deleteFailed',
  compartment_full: 'apiError.compartmentFull',
  rate_limited: 'apiError.rateLimited',
  provider_unavailable: 'apiError.providerUnavailable',
  page_locked: 'apiError.pageLocked',
  binder_locked: 'apiError.binderLocked',
  location_name_taken: 'apiError.locationNameTaken',
  last_compartment: 'apiError.lastCompartment',
  import_too_many_rows: 'apiError.importTooManyRows',
  import_empty: 'apiError.importEmpty',
  import_invalid: 'apiError.importInvalid',
  import_no_match: 'apiError.importNoMatch',
  import_failed: 'apiError.importFailed',
  csv_no_headers: 'apiError.csvNoHeaders',
  manabox_empty: 'apiError.manaboxEmpty',
  manabox_no_match: 'apiError.manaboxNoMatch',
  share_not_found: 'apiError.shareNotFound',
  share_no_locations: 'apiError.shareNoLocations',
  container_not_found: 'apiError.containerNotFound',
  deck_name_required: 'apiError.deckNameRequired',
  deck_not_enough_cards: 'apiError.deckNotEnoughCards',
  invalid_credentials: 'apiError.invalidCredentials',
  registration_disabled: 'apiError.registrationDisabled',
  username_taken: 'apiError.usernameTaken',
  wrong_password: 'apiError.wrongPassword',
  restore_too_many_cards: 'apiError.restoreTooManyCards',
  restore_claimed_units: 'apiError.restoreClaimedUnits',
  api_key_shown_once: 'apiError.apiKeyShownOnce',
  // Trades and gifts between members (routes/transfers.js) and deals recorded
  // with people outside Bindarr. The generic codes (not_found, invalid,
  // server_error) are worded for any route that answers with them.
  not_found: 'apiError.notFound',
  invalid: 'apiError.invalid',
  server_error: 'apiError.serverError',
  forbidden: 'apiError.forbidden',
  not_pending: 'apiError.notPending',
  needs_counter: 'apiError.needsCounter',
  already_owned: 'apiError.alreadyOwned',
  name_taken: 'apiError.nameTaken',
  trades_disabled: 'apiError.tradesDisabled',
  api_key_refused: 'apiError.apiKeyRefused',
  too_many_pending: (p) => (p && p.max != null ? 'apiError.tooManyPendingMax' : 'apiError.tooManyPending'),
  asset_changed: 'apiError.assetChanged',
  deck_allocated: (p) => (p && p.decks ? 'apiError.deckAllocatedNamed' : 'apiError.deckAllocated'),
  unit_claimed: 'apiError.unitClaimed',
  // The PWA answers a write made offline itself (utils/offline.js).
  offline: 'offline.writeBlocked',
};

// Names joined the way the interface language lists them ("A, B and C").
function listText(names) {
  try {
    return new Intl.ListFormat(getActiveLocale(), { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

// What a sentence needs that a body carries beside `params` rather than in it.
const BODY_PARAMS = {
  // { decks: ['Mew box', ...] } (also in params): the checked-out decks holding
  // the copies, named in a list, counted for the sentence's plural.
  deck_allocated: (body) => {
    const given = Array.isArray(body.decks) ? body.decks : body.params?.decks;
    const names = Array.isArray(given) ? given.filter(name => typeof name === 'string' && name) : [];
    return names.length ? { decks: listText(names), count: names.length } : { decks: undefined };
  },
};

const has = (table, code) => typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code);

function paramsOf(body) {
  const extra = has(BODY_PARAMS, body.code) ? BODY_PARAMS[body.code](body) : {};
  return { ...(body.params && typeof body.params === 'object' ? body.params : {}), ...extra };
}

// The translation key for a body's code, or null.
export const apiErrorKey = (body) => {
  const entry = body && typeof body === 'object' && has(KEYS, body.code) ? KEYS[body.code] : null;
  return typeof entry === 'function' ? entry(paramsOf(body)) : entry || null;
};

export function apiErrorText(t, body, fallbackKey, fallbackVars) {
  const key = apiErrorKey(body);
  if (key) {
    // Params are data from the server; strings so a cert number is never
    // regrouped as if it were a quantity.
    const params = Object.fromEntries(Object.entries(paramsOf(body)).map(([k, v]) => [k, typeof v === 'number' && k !== 'count' && k !== 'max' ? String(v) : v]));
    return t(key, params);
  }
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return t(fallbackKey, fallbackVars);
}
