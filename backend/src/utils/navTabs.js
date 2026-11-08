// The nav-bar tabs a user may show or hide (users.nav_tabs). Dashboard,
// Collection and Settings are always shown, so they are not here. The SPA's
// utils/navTabs.js holds the same list with the defaults and the ordering; this
// side only checks what is stored.
const OPTIONAL_NAV_TABS = ['add-cards', 'sets', 'storage', 'deckbuilder', 'lists', 'notes', 'sealed'];

// What to store for a PUT body's nav_tabs. null (or '') resets to the default
// set; an array keeps the known tabs once each, in the canonical order, so an
// older client cannot store a tab a newer server dropped. Anything else is an
// error: { error } or { value }.
function parseNavTabs(input) {
  if (input === null || input === '') return { value: null };
  if (!Array.isArray(input) || input.length > 50 || input.some(t => typeof t !== 'string')) {
    return { error: 'nav_tabs must be a list of tab names, or null' };
  }
  const wanted = new Set(input);
  return { value: JSON.stringify(OPTIONAL_NAV_TABS.filter(t => wanted.has(t))) };
}

// The stored column back out: an array, or null for "the default set".
function readNavTabs(stored) {
  if (stored == null || stored === '') return null;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(t => OPTIONAL_NAV_TABS.includes(t)) : null;
  } catch {
    return null;
  }
}

module.exports = { OPTIONAL_NAV_TABS, parseNavTabs, readNavTabs };
