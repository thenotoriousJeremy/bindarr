import { useEffect, useMemo, useRef, useState } from 'react';
import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';
import { groupTransferHistory } from '../../utils/transferHistory';
import { calendarDateText, otherParty, sameUser } from '../../utils/transferView';
import { ExternalDealHistory } from './ExternalDeals';
import LoadMore from './LoadMore';
import TransferCard from './TransferCard';

const FINAL_STATUSES = ['accepted', 'rejected', 'cancelled'];
const muted = { color: 'var(--text-secondary)' };
// No first page yet, and no failure to show instead.
const waiting = list => !list.loaded && !list.error;

function LoadError({ list, fallbackKey }) {
  const { t } = useT();
  if (!list.error || list.loaded) return null;
  return <div role="alert" style={{ color: 'var(--accent-red)' }}>{apiErrorText(t, list.error.body, fallbackKey)}</div>;
}

// One negotiation with a member: the opening offer and every counter, closed
// under the outcome's summary.
function NegotiationGroup({ group, me, open, onToggle }) {
  const { t } = useT();
  const partner = otherParty(group.root, me).name || t('transfer.unknownUser');
  const outcome = group.transfers.find(item => FINAL_STATUSES.includes(item.status)) || group.transfers[0];
  const summary = (outcome.items || []).map((item) => {
    const snapshot = item.item_snapshot || item;
    const name = snapshot.name || snapshot.product_name || snapshot.card_id || t('transfer.unknownItem');
    return t(sameUser(item.from_user_id, me) ? 'transfer.youOfferedItem' : 'transfer.theyOfferedItem', { item: name });
  });
  const rootId = String(group.root.id);
  return (
    <details
      id={`transfer-history-${rootId}`}
      className="glass-panel"
      open={open}
      onToggle={event => onToggle(rootId, event.currentTarget.open)}
      style={{ padding: '0.75rem' }}
    >
      <summary style={{ cursor: 'pointer', color: 'var(--text-strong)' }}>
        <strong>{t('transfer.negotiationWith', { user: partner })}</strong>
        <span style={{ marginLeft: '0.5rem', ...muted }}>{t(`transfer.status.${outcome.status}`)}</span>
        <span style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.85rem', ...muted }}>{summary.join(' · ')}</span>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '0.75rem' }}>
        {group.transfers.map(transfer => <TransferCard key={transfer.id} transfer={transfer} me={me} readOnly />)}
      </div>
    </details>
  );
}

// A trade recorded after the fact, which the other member confirms or declines.
// Confirming moves cards, so it needs trading on (`canTrade`); declining a
// record sent to you and cancelling your own stay allowed with it off
// (`canDecline`), from the row itself since there is nothing to review.
function PastTradeRow({ trade, me, canTrade, canDecline, busy, onReview, onDecline, onCancel }) {
  const { t, locale } = useT();
  const isCreator = sameUser(trade.creator_id, me);
  const party = otherParty(trade, me, 'creator', 'recipient');
  const awaiting = trade.status === 'pending_confirmation';
  const canReview = awaiting && !isCreator && canTrade && party.id != null;
  const canDeclineHere = awaiting && !isCreator && !canReview && canDecline;
  const canCancel = awaiting && isCreator && canDecline;
  return (
    <article id={`historical-trade-${trade.id}`} className="glass-panel" style={{ padding: '0.85rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: 'var(--text-strong)' }}>{t('historical.tradeWith', { user: party.name || t('transfer.unknownUser') })}</strong>
          <span style={{ marginLeft: '0.5rem', fontSize: '0.84rem', ...muted }}>
            {t(`historical.status.${trade.status}`)} · {calendarDateText(trade.completed_at, locale)}
          </span>
        </div>
        {canReview && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onReview(trade)}>{t('historical.review')}</button>
        )}
        {canDeclineHere && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onDecline(trade)}>{t('historical.reject')}</button>
        )}
        {canCancel && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCancel(trade)}>{t('transfer.cancel')}</button>
        )}
      </div>
      {awaiting && !isCreator && !canTrade && canDecline && (
        <p role="note" style={{ margin: '0.45rem 0 0', fontSize: '0.85rem', ...muted }}>{t('historical.confirmNeedsTrading')}</p>
      )}
      {trade.message && <p style={{ margin: '0.45rem 0', ...muted }}>{trade.message}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.35rem 1rem', marginTop: '0.45rem' }}>
        {(trade.items || []).map((item) => {
          const snapshot = item.item_snapshot || {};
          const name = snapshot.name || item.card_id || t('transfer.unknownItem');
          return (
            <div key={item.id} style={{ fontSize: '0.84rem', ...muted }}>
              {item.quantity > 1 ? t('transfer.quantityTimes', { count: Number(item.quantity), item: name }) : name}
              <span style={{ marginLeft: '0.35rem', color: 'var(--text-muted)' }}>
                {t(sameUser(item.from_user_id, me) ? 'historical.youGave' : 'historical.theyGave')}
              </span>
              <div style={{ fontSize: '0.78rem' }}>{[snapshot.set_name, snapshot.number && `#${snapshot.number}`].filter(Boolean).join(' · ')}</div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

const toggleIn = (setter) => (id, open) => setter((current) => {
  if (current.has(id) === open) return current;
  const next = new Set(current);
  if (open) next.add(id);
  else next.delete(id);
  return next;
});

// The History page: finished negotiations with members and the trades recorded
// with them (both left out on a phone, which has no members), then deals
// recorded with people outside Bindarr. Each list pages on its own.
// `target` ({ kind, id, nonce }) is an item a card's provenance link asked for,
// already loaded by TransferManager: it is opened and scrolled to.
export default function TransferHistory({
  me,
  access,
  transfers,
  historical,
  external,
  busy,
  target,
  onRecordPastTrade,
  onReviewPastTrade,
  onDeclinePastTrade,
  onCancelPastTrade,
}) {
  const { t } = useT();
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [openDeals, setOpenDeals] = useState(() => new Set());
  const [scrollTo, setScrollTo] = useState(null);
  const groups = useMemo(() => groupTransferHistory(transfers.items), [transfers.items]);

  const handledTarget = useRef(null);
  useEffect(() => {
    if (!target || handledTarget.current === target.nonce) return;
    if (target.kind === 'internal') {
      const group = groups.find(item => item.transfers.some(transfer => String(transfer.id) === String(target.id)));
      if (!group) return;
      const rootId = String(group.root.id);
      setOpenGroups(current => new Set([...current, rootId]));
      setScrollTo(`transfer-history-${rootId}`);
    } else if (target.kind === 'historical') {
      setScrollTo(`historical-trade-${target.id}`);
    } else if (target.kind === 'external') {
      setOpenDeals(current => new Set([...current, String(target.id)]));
      setScrollTo(`external-trade-${target.id}`);
    }
    handledTarget.current = target.nonce;
  }, [target, groups]);

  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setScrollTo(null);
  }, [scrollTo]);

  const memberHistoryEmpty = transfers.loaded && historical.loaded
    && groups.length === 0 && historical.items.length === 0
    && transfers.cursor == null && historical.cursor == null;

  return (
    <>
      {access.members && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.history')}</h3>
            {access.canTrade && (
              <button type="button" className="btn btn-primary" onClick={onRecordPastTrade}>{t('historical.openForm')}</button>
            )}
          </div>
          <LoadError list={transfers} fallbackKey="transfer.errLoad" />
          {waiting(transfers) ? <p style={muted}>{t('common.loading')}</p> : groups.map(group => (
            <NegotiationGroup
              key={group.root.id}
              group={group}
              me={me}
              open={openGroups.has(String(group.root.id))}
              onToggle={toggleIn(setOpenGroups)}
            />
          ))}
          <LoadMore list={transfers} />
          {(historical.items.length > 0 || !historical.loaded) && (
            <h4 style={{ margin: '0.4rem 0 0', color: 'var(--text-strong)' }}>{t('historical.title')}</h4>
          )}
          <LoadError list={historical} fallbackKey="historical.errLoad" />
          {waiting(historical) ? <p style={muted}>{t('common.loading')}</p> : historical.items.map(trade => (
            <PastTradeRow
              key={`past-${trade.id}`}
              trade={trade}
              me={me}
              canTrade={access.canTrade}
              canDecline={access.canDecline}
              busy={busy}
              onReview={onReviewPastTrade}
              onDecline={onDeclinePastTrade}
              onCancel={onCancelPastTrade}
            />
          ))}
          <LoadMore list={historical} />
          {memberHistoryEmpty && <p style={muted}>{t('transfer.noHistory')}</p>}
        </section>
      )}
      <ExternalDealHistory list={external} expandedIds={openDeals} onToggle={toggleIn(setOpenDeals)} />
    </>
  );
}
