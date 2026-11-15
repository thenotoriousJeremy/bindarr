import { LayoutDashboard, Database, MapPin, Settings, ShieldAlert, Plus, Swords, StickyNote, Package, ListChecks, Library } from 'lucide-react';

// Each tab's label key and icon, in one place: the nav bar, its More menu and
// the header buttons (App.jsx) and the nav-bar setting (NavTabsSettings) all
// name tabs from here.
export const NAV_TAB_META = {
  dashboard: ['nav.dashboard', LayoutDashboard],
  'add-cards': ['nav.addCards', Plus],
  collection: ['nav.collection', Database],
  sets: ['nav.browse', Library],
  storage: ['nav.storage', MapPin],
  deckbuilder: ['nav.deckBuilder', Swords],
  lists: ['nav.lists', ListChecks],
  notes: ['nav.notes', StickyNote],
  sealed: ['nav.sealed', Package],
  settings: ['nav.settings', Settings],
  admin: ['nav.admin', ShieldAlert],
};
