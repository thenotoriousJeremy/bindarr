// The signed-in user, as App.jsx keeps it in localStorage between visits.
//
// The server reports provider keys and the API key as has_* flags and never sends
// the keys themselves. Builds before that stored them here in plain text, where
// anything that can run script on the page can read them long after the tab is
// closed. Every read and write goes through scrubUser, so an old copy is cleaned
// the first time this build loads it, and nothing secret is written again even if
// some response were to carry it.
//
// Other code reads this copy too (CardArtEditor checks `role`), so the scrub
// removes only the secret fields and leaves the rest as the server sent it.
const STORAGE_KEY = 'bindarr_user';
const SECRET_FIELDS = ['tcg_api_key', 'psa_api_token', 'graded_price_api_key', 'api_key'];

export function scrubUser(user) {
  if (!user || typeof user !== 'object') return user;
  const clean = { ...user };
  for (const field of SECRET_FIELDS) delete clean[field];
  return clean;
}

// Null when nothing (readable) is stored. Writes the scrubbed copy back when the
// stored one still held a secret, so it does not wait for the next save.
export function loadStoredUser(storage = localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const clean = scrubUser(parsed);
    if (SECRET_FIELDS.some(field => field in parsed)) storage.setItem(STORAGE_KEY, JSON.stringify(clean));
    return clean;
  } catch {
    return null;
  }
}

export function saveStoredUser(user, storage = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(scrubUser(user)));
}
