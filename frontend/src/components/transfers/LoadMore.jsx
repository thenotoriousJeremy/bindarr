import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';

// "Load more" under a paged list (useTransfers' lists, utils/pagedList.js):
// shown while the server has a page after the ones loaded. A page that failed
// says so here, and the button tries it again.
export default function LoadMore({ list }) {
  const { t } = useT();
  if (!list.loaded || list.cursor == null) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem' }}>
      {list.error && !list.loadingMore && (
        <div role="alert" style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>
          {apiErrorText(t, list.error.body, 'transfer.errLoadMore')}
        </div>
      )}
      <button type="button" className="btn btn-secondary" disabled={list.loadingMore} onClick={() => list.loadMore()}>
        {list.loadingMore ? t('common.loading') : t('transfer.loadMore')}
      </button>
    </div>
  );
}
