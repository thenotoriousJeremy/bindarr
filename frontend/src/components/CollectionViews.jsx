import { Database, Library, ListChecks, Package } from 'lucide-react';
import { useT } from '../utils/i18n';

// Collection's sub-views: the cards you own, Browse (every card of a set, the
// Sets view), your lists, your sealed product. Each is still its own tab under
// the hood (its own URL, kept mounted once visited), so this only switches
// between them; App.jsx shows it above whichever one is open.
const VIEWS = [
  ['collection', 'nav.cards', Database],
  ['sets', 'nav.browse', Library],
  ['lists', 'nav.lists', ListChecks],
  ['sealed', 'nav.sealed', Package],
];

export default function CollectionViews({ active, onSelect }) {
  const { t } = useT();
  return (
    <nav className="sub-nav-tabs collection-views" aria-label={t('nav.collectionViews')}>
      {VIEWS.map(([view, label, Icon]) => (
        <button
          key={view}
          type="button"
          className={`sub-nav-tab ${active === view ? 'active' : ''}`}
          aria-current={active === view ? 'page' : undefined}
          onClick={() => onSelect(view)}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{t(label)}</span>
        </button>
      ))}
    </nav>
  );
}
