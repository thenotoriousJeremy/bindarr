import { AlertTriangle, ArrowLeftRight, Check, Gift, RefreshCw, X } from 'lucide-react';
import { conditionLabel, printingLabel } from '../../utils/cardOptions';
import { useT } from '../../utils/i18n';
import {
  cardLocationLabel, costText, gradeText, isOneSidedTrade, otherParty, sameUser, timestampText, transferRole,
} from '../../utils/transferView';

const note = { color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.6rem 0 0' };

// One item line of a transfer: the snapshot taken when it was offered, so it
// still reads the same after the copy has moved. `location` is where your own
// copy sits now, while the offer is open.
export function TransferItemRow({ item, me, location = null, showCost = true }) {
  const { t, locale } = useT();
  const snapshot = item.item_snapshot || item;
  const sentByMe = sameUser(item.from_user_id, me);
  const cost = sentByMe ? item.purchase_cost : item.received_cost;
  const name = snapshot.name || snapshot.product_name || t('transfer.unknownItem');
  const details = item.item_type === 'card'
    ? [
      snapshot.set_name,
      snapshot.number && `#${snapshot.number}`,
      snapshot.printing && `${t('transfer.printing')}: ${printingLabel(t, snapshot.printing, snapshot.game)}`,
      gradeText(snapshot) || (snapshot.condition && conditionLabel(t, snapshot.condition)),
      snapshot.language,
    ]
    : [snapshot.sealed_type, snapshot.origin_product_name && t('transfer.fromProduct', { product: snapshot.origin_product_name })];
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', padding: '0.45rem 0', borderBottom: '1px solid var(--border-glass)' }}>
      <div style={{ minWidth: 0 }}>
        <strong style={{ color: 'var(--text-strong)' }}>
          {item.quantity > 1 ? t('transfer.quantityTimes', { count: Number(item.quantity), item: name }) : name}
        </strong>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{details.filter(Boolean).join(' · ')}</div>
        {location && item.item_type === 'card' && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('transfer.location')}: {cardLocationLabel(location, t)}
          </div>
        )}
      </div>
      {showCost && (
        <span style={{ whiteSpace: 'nowrap', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          {costText(cost, locale) ?? t('transfer.unknownCost')}
        </span>
      )}
    </div>
  );
}

// A warning that accepting may leave a checked-out deck short: rebuilt from its
// numbers, so it reads in the interface language.
function deckWarningText(t, warning) {
  if (warning.copies_short != null && warning.card_name) {
    return t('transfer.deckShort', { count: Number(warning.copies_short), card: warning.card_name });
  }
  return warning.message || '';
}

// One proposal, gift or trade, from the viewer's side (utils/tradeAccess):
// `canTrade` offers Accept and Counter, `canDecline` Reject on one sent to you
// and Cancel on your own, which stay while trading is switched off. `readOnly`
// shows it as a step of a finished negotiation.
export default function TransferCard({
  transfer,
  me,
  readOnly = false,
  canTrade = true,
  canDecline = true,
  busy = false,
  onRespond,
  onCounter,
  locateCard,
}) {
  const { t, locale } = useT();
  const role = transferRole(transfer, me);
  const incoming = role === 'incoming';
  const pending = transfer.status === 'pending';
  const partner = otherParty(transfer, me).name || t('transfer.unknownUser');
  const oneSided = isOneSidedTrade(transfer, me);
  // Nothing to trade with once the other member's account is gone; saying no
  // still clears it away.
  const partnerGone = otherParty(transfer, me).id == null;
  const open = pending && !readOnly && role != null;
  const canAccept = open && incoming && canTrade && !partnerGone && !oneSided;
  const canCounter = open && incoming && canTrade && !partnerGone;
  const canReject = open && incoming && canDecline;
  const canCancel = open && !incoming && canDecline;
  const when = timestampText(transfer.completed_at || transfer.updated_at || transfer.created_at, locale);
  return (
    <article className="glass-panel" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {transfer.transfer_type === 'gift' ? <Gift size={16} aria-hidden="true" /> : <ArrowLeftRight size={16} aria-hidden="true" />}
          <strong style={{ color: 'var(--text-strong)' }}>
            {incoming ? t('transfer.fromUser', { user: partner }) : t('transfer.toUser', { user: partner })}
          </strong>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{t(`transfer.status.${transfer.status}`)}</span>
          {when && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{when}</span>}
        </div>
        {(canAccept || canCounter || canReject) && (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {canAccept && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onRespond(transfer, 'accept')}>
                <Check size={14} /> {t('transfer.accept')}
              </button>
            )}
            {canCounter && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCounter(transfer)}>
                <RefreshCw size={14} /> {t('transfer.counter')}
              </button>
            )}
            {canReject && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onRespond(transfer, 'reject')}>
                <X size={14} /> {t('transfer.reject')}
              </button>
            )}
          </div>
        )}
        {canCancel && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onRespond(transfer, 'cancel')}>
            {t('transfer.cancel')}
          </button>
        )}
      </div>
      {readOnly && pending && <p role="note" style={note}>{t('transfer.pendingInOffers')}</p>}
      {open && incoming && !canTrade && <p role="note" style={note}>{t('transfer.answerNeedsTrading')}</p>}
      {canCounter && oneSided && <p role="note" style={note}>{t('transfer.counterRequired')}</p>}
      {transfer.message && <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0.5rem 0' }}>{transfer.message}</p>}
      <div style={{ marginTop: '0.5rem' }}>
        {(transfer.items || []).map(item => (
          <TransferItemRow key={item.id} item={item} me={me} location={pending && locateCard ? locateCard(item) : null} />
        ))}
      </div>
      {transfer.deck_warnings?.map((warning, index) => (
        <div key={`${warning.card_id}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-yellow)', fontSize: '0.78rem', marginTop: '0.5rem' }}>
          <AlertTriangle size={14} aria-hidden="true" /> {deckWarningText(t, warning)}
        </div>
      ))}
    </article>
  );
}
