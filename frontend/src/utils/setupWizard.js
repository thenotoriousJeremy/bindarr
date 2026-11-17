// The first-run wizard's steps, and the decisions about them that need no React
// (components/SetupWizard.jsx renders them; setupWizard.test.js checks them).

// In order. The server keeps the one the wizard is on by name
// (app_settings.setup_step), not by index, so a release that adds or reorders a
// step still reopens an unfinished wizard at the same one.
export const SETUP_STEPS = ['language', 'cards', 'scanning', 'keys', 'storage', 'tour'];

// Where the wizard opens, from GET /api/settings: null once it is finished or
// skipped, otherwise the step it was closed on. A name this build does not have
// opens it at the start.
export function resumeStep(settings) {
  if (!settings || settings.setup_complete) return null;
  const at = SETUP_STEPS.indexOf(settings.setup_step);
  return at < 0 ? 0 : at;
}

// The per-user pokemontcg.io key is only ever sent to pokemontcg.io, which only an
// install pinned to that provider still uses (backend utils/pokemonProvider.js).
// TCGdex, the default, needs no key, and pokemontcgapi takes the server's own
// POKEMONTCGAPI_KEY, so on those installs the box would do nothing.
export const pokemonTcgKeyApplies = (provider) => provider === 'pokemontcg';

// What the keys step saves: the boxes with something typed in, as the body
// PUT /api/auth/settings takes. An empty box keeps the saved key, so it is left
// out, and so is the pokemontcg.io box on an install that does not show it.
export function keysToSave({ tcg = '', psa = '', graded = '' } = {}, { pokemonTcg = false } = {}) {
  return Object.fromEntries([
    ['tcg_api_key', pokemonTcg ? tcg : ''],
    ['psa_api_token', psa],
    ['graded_price_api_key', graded],
  ].filter(([, value]) => value.trim()));
}
