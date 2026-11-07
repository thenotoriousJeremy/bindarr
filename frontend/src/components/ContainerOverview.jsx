import { useMemo } from 'react';
import { Lock } from 'lucide-react';
import { isBinderType } from '../utils/cardOptions';
import { displayName } from '../utils/languages';
import { layoutPockets, pageColumns as resolvePageColumns } from '../utils/binderLayout';
import { dividerStarts, groupByDividers } from '../utils/sortCategories';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';

// Every card in a container at once, laid out the way it sits: a box row by row
// with a break at each divider, a binder page by page with its pockets. Order
// and dividers come from the same code the coverflow and the binder pages use,
// so nothing here can disagree with where a card actually is.

const EMPTY = [];

function DividerChips({ cats }) {
  return cats.map(div => (
    <span key={div.field} className="container-overview-chip" style={{ background: div.color }}>{div.label}</span>
  ));
}

function OverviewTile({ card, slot, selected, onCardClick, starts = EMPTY }) {
  const { t } = useT();
  const name = displayName(card);
  return (
    <button
      type="button"
      className={`container-overview-tile ${selected ? 'selected' : ''}`}
      onClick={() => onCardClick(card)}
      aria-label={name}
      title={t('loc.overviewCardTitle', { name, slot })}
    >
      {/* Card-shaped before its image arrives, so a long row does not jump about
          as the lazy images below the fold load in. */}
      <CardImage card={card} loading="lazy" decoding="async" style={{ width: '100%', aspectRatio: '0.718', objectFit: 'cover', borderRadius: '3px' }} />
      {card.quantity > 1 && <span className="container-overview-qty">&times;{card.quantity}</span>}
      {starts.length > 0 && (
        <span className="container-overview-pocket-chips"><DividerChips cats={starts} /></span>
      )}
    </button>
  );
}

// A box row: its cards in coverflow order, split at the dividers.
function RowCards({ cards, sortOrder, setsList, tileMin, selectedIds, onCardClick }) {
  const { t } = useT();
  const groups = useMemo(() => groupByDividers(cards, sortOrder, setsList), [cards, sortOrder, setsList]);
  return groups.map(group => (
    <div key={group.start} className="container-overview-group">
      {group.path.length > 0 && (
        <div className="container-overview-group-head">
          <DividerChips cats={group.path} />
          <span>{t('loc.overviewSlots', { start: group.start + 1, end: group.start + group.cards.length })}</span>
        </div>
      )}
      <div className="container-overview-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }}>
        {group.cards.map((card, i) => (
          <OverviewTile
            key={card.entry_id}
            card={card}
            slot={group.start + i + 1}
            selected={!!selectedIds?.has(card.entry_id)}
            onCardClick={onCardClick}
          />
        ))}
      </div>
    </div>
  ));
}

// A binder page: its pockets, empty ones included, with a label where a divider
// starts — the page as it sits in the binder, at overview size.
function PagePockets({ compartment, cards, location, setsList, tileMin, selectedIds, onCardClick }) {
  const cols = resolvePageColumns(compartment.capacity, location.page_columns);
  const pockets = useMemo(
    () => layoutPockets(cards, compartment.capacity, !!location.allow_stacking),
    [cards, compartment.capacity, location.allow_stacking]
  );
  const starts = useMemo(() => dividerStarts(pockets, location.sort_order, setsList), [pockets, location.sort_order, setsList]);
  return (
    <div className="container-overview-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${tileMin}px)` }}>
      {pockets.map((card, i) => (card ? (
        <OverviewTile
          key={card.entry_id || `pocket-${i}`}
          card={card}
          slot={i + 1}
          starts={starts[i]}
          selected={!!selectedIds?.has(card.entry_id)}
          onCardClick={onCardClick}
        />
      ) : (
        <div key={`empty-${i}`} className="container-overview-empty">{i + 1}</div>
      )))}
    </div>
  );
}

export default function ContainerOverview({
  location,
  compartments,
  cardsByCompartment,
  setsList = [],
  // The overview's +/- size control: 1 is an 84px card.
  cardScale = 1,
  // Set while select mode is on; tapping a card then toggles it.
  selectedIds = null,
  onCardClick,
  // Switch back to the coverflow or page view at this row or page.
  onOpenCompartment,
}) {
  const { t } = useT();
  const isBinder = isBinderType(location.type);
  const tileMin = Math.round(84 * cardScale);

  if (compartments.length === 0) {
    return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('loc.noCompartments')}</p>;
  }

  return (
    <div className={`container-overview ${isBinder ? 'pages' : ''}`}>
      {compartments.map(c => {
        const cards = cardsByCompartment.get(c.id) || EMPTY;
        const free = c.free ?? (c.capacity - cards.length);
        return (
          <section key={c.id} className="container-overview-section">
            <div className="container-overview-head">
              <strong>{c.display_label}</strong>
              {!!c.locked && <Lock size={11} aria-hidden="true" />}
              <span>{c.count ?? cards.length} / {c.capacity}</span>
              {!isBinder && free > 0 && <span className="container-overview-free">{t('loc.emptySlots', { count: free })}</span>}
              <button type="button" className="btn btn-secondary container-overview-open" onClick={() => onOpenCompartment(c.id)}>
                {t(isBinder ? 'loc.openPage' : 'loc.openRow')}
              </button>
            </div>
            {isBinder ? (
              <PagePockets compartment={c} cards={cards} location={location} setsList={setsList} tileMin={tileMin} selectedIds={selectedIds} onCardClick={onCardClick} />
            ) : cards.length === 0 ? (
              <p className="container-overview-none">{t('compartment.emptyRow')}</p>
            ) : (
              <RowCards cards={cards} sortOrder={location.sort_order} setsList={setsList} tileMin={tileMin} selectedIds={selectedIds} onCardClick={onCardClick} />
            )}
          </section>
        );
      })}
    </div>
  );
}
