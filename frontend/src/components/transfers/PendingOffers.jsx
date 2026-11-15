import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';
import TransferCard from './TransferCard';

// The Offers page: proposals still waiting, to you (`incoming`) and from you
// (`outgoing`), split by utils/transferView pendingTransfers. The first page of
// GET /api/transfers carries every pending one, so this page needs no "Load more".
// `list` is useTransfers' transfers list, for its loading and error state;
// `canTrade` and `canDecline` come from utils/tradeAccess.
export default function PendingOffers({ list, incoming, outgoing, me, canTrade, canDecline, busy, onRespond, onCounter, locateCard }) {
  const { t } = useT();
  if (list.error && !list.loaded) {
    return <div role="alert" style={{ color: 'var(--accent-red)' }}>{apiErrorText(t, list.error.body, 'transfer.errLoad')}</div>;
  }
  const waiting = !list.loaded;
  const section = (titleKey, transfers, emptyKey) => (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t(titleKey)}</h3>
      {waiting ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
        : transfers.length ? transfers.map(transfer => (
          <TransferCard
            key={transfer.id}
            transfer={transfer}
            me={me}
            canTrade={canTrade}
            canDecline={canDecline}
            busy={busy}
            onRespond={onRespond}
            onCounter={onCounter}
            locateCard={locateCard}
          />
        )) : <p style={{ color: 'var(--text-secondary)' }}>{t(emptyKey)}</p>}
    </section>
  );
  return (
    <>
      {section('transfer.pendingIncoming', incoming, 'transfer.noneIncoming')}
      {section('transfer.pendingOutgoing', outgoing, 'transfer.noneOutgoing')}
    </>
  );
}
