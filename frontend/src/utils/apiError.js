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
};

// The translation key for a body's code, or null.
export const apiErrorKey = (body) => {
  const entry = body && typeof body === 'object' ? KEYS[body.code] : null;
  return typeof entry === 'function' ? entry(body.params) : entry || null;
};

export function apiErrorText(t, body, fallbackKey, fallbackVars) {
  const key = apiErrorKey(body);
  if (key) {
    // Params are data from the server; strings so a cert number is never
    // regrouped as if it were a quantity.
    const params = Object.fromEntries(Object.entries(body.params || {}).map(([k, v]) => [k, typeof v === 'number' && k !== 'count' && k !== 'max' ? String(v) : v]));
    return t(key, params);
  }
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return t(fallbackKey, fallbackVars);
}
