// Which tabs the nav bar shows. Dashboard, Collection and Settings always do
// (and Admin, for an admin); the rest are the user's choice, stored on the
// server as users.nav_tabs (null: the defaults below). Pure functions, so they
// run under node:test; App.jsx and Settings use them.
//
// Browse (the 'sets' tab), Lists and Sealed live inside Collection as its
// sub-views (CollectionViews.jsx), so by default they are not tabs of their own.
// Pinning one adds a tab for it as well; it stays reachable from Collection.
// Their routes are unchanged (/sets/..., /lists/:id, /sealed), so every old link
// still opens the same view, now shown under Collection.

export const ALWAYS_NAV_TABS = ['dashboard', 'collection', 'settings'];
export const OPTIONAL_NAV_TABS = ['add-cards', 'sets', 'storage', 'deckbuilder', 'lists', 'notes', 'sealed'];
export const DEFAULT_NAV_TABS = ['add-cards', 'storage', 'deckbuilder', 'notes'];
export const COLLECTION_VIEWS = ['collection', 'sets', 'lists', 'sealed'];

const BAR_ORDER = ['dashboard', 'add-cards', 'collection', 'sets', 'storage', 'deckbuilder', 'lists', 'notes', 'sealed', 'settings', 'admin'];

export const isCollectionView = (tab) => COLLECTION_VIEWS.includes(tab);

// The optional tabs pinned, in bar order. Anything but an array is the default.
export function pinnedTabs(navTabs) {
  if (!Array.isArray(navTabs)) return [...DEFAULT_NAV_TABS];
  return OPTIONAL_NAV_TABS.filter(tab => navTabs.includes(tab));
}

// The tabs the bar shows, in order. A hidden tab that is open anyway (a link,
// Back) shows while it is open, so the bar never loses track of where you are --
// unless it is a Collection sub-view, which Collection stands for.
export function navBarTabs(navTabs, { showAdmin = false, activeTab = null } = {}) {
  const pinned = pinnedTabs(navTabs);
  return BAR_ORDER.filter(tab => {
    if (tab === 'admin') return showAdmin;
    if (ALWAYS_NAV_TABS.includes(tab) || pinned.includes(tab)) return true;
    return tab === activeTab && !isCollectionView(tab);
  });
}

// The bar tab drawn as active: the open tab when it is on the bar, otherwise
// Collection for one of its sub-views.
export function litNavTab(activeTab, barTabs) {
  if (barTabs.includes(activeTab)) return activeTab;
  return isCollectionView(activeTab) ? 'collection' : activeTab;
}

// Pin or unpin one tab, keeping bar order. Always tabs cannot be toggled.
export function toggleNavTab(navTabs, tab) {
  if (!OPTIONAL_NAV_TABS.includes(tab)) return pinnedTabs(navTabs);
  const pinned = pinnedTabs(navTabs);
  const next = pinned.includes(tab) ? pinned.filter(t => t !== tab) : [...pinned, tab];
  return OPTIONAL_NAV_TABS.filter(t => next.includes(t));
}

// Where the Collection tab goes when tapped: from inside Collection, its first
// view (Cards); from elsewhere, back to the sub-view last open there -- unless
// that view has a tab of its own on the bar, which is where it lives then.
export function collectionTarget(activeTab, lastView, barTabs = []) {
  if (isCollectionView(activeTab)) return 'collection';
  if (!isCollectionView(lastView) || (lastView !== 'collection' && barTabs.includes(lastView))) return 'collection';
  return lastView;
}
