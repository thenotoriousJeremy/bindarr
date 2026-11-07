import { memo } from 'react';
import { onActivateKey } from '../../utils/a11y';
import { getCardDisplayName } from '../../utils/langHelper';
import Price from '../Price';
import { useT } from '../../utils/i18n';

// The strip of cards this session added, with long-press multi-select and
// bulk actions. Moved out of CameraScanner unchanged and memoized.
function RecentScans({
  recentSelect, setRecentScans, recentScans, activateRecent,
}) {
  const { t } = useT();
  return (
    <div className="glass-panel" style={{ width: '100%', marginTop: '1rem' }}>
      <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', marginBottom: '0.85rem', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{t('scan.recentScans')}</span>
        {recentSelect.selectMode
          ? <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={recentSelect.exitSelectMode}>{t('bulk.done')}</button>
          : <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => setRecentScans([])}>{t('scan.clearHistory')}</button>}
      </h3>

      {/* Bulk action bar (select mode). Same actions/endpoint as the collection page. */}
      {recentSelect.selectMode && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginBottom: '0.6rem' }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.8rem', marginRight: '0.25rem' }}>{recentSelect.selectedIds.size} selected</span>
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('delete', null, t('bulk.confirmDelete', { count: recentSelect.selectedIds.size }))}>{t('bulk.delete')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('trade', null)}>{t('bulk.markTrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('list_type', 'wishlist')}>{t('bulk.moveToWishlist')}</button>
        </div>
      )}

      {/* Horizontal strip of recent scans, card-shaped like the box tiles.
          Tap = edit; long-press = multi-select (shared with collection page). */}
      <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.4rem' }}>
        {recentScans.map((item, idx) => {
          const selected = recentSelect.selectMode && recentSelect.selectedIds.has(item.entry_id);
          return (
          <div
            key={idx}
            role="button"
            tabIndex={0}
            aria-pressed={recentSelect.selectMode ? selected : undefined}
            onClick={() => activateRecent(item)}
            onKeyDown={onActivateKey(() => activateRecent(item))}
            {...recentSelect.pressHandlers(item.entry_id)}
            title={t('scan.tapEditHoldSelect')}
            style={{ flex: '0 0 auto', width: '76px', display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', userSelect: 'none', WebkitTouchCallout: 'none', opacity: recentSelect.selectMode && !selected ? 0.55 : 1 }}
          >
            <img
              src={item.image_url}
              alt={getCardDisplayName(item.name, item.language, item.printed_name)}
              draggable={false}
              style={{ width: '76px', height: '106px', objectFit: 'cover', borderRadius: '4px', border: selected ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', boxShadow: selected ? '0 0 12px var(--accent-red-glow)' : '0 2px 6px rgba(0,0,0,0.3)', pointerEvents: 'none' }}
            />
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent-yellow)', textAlign: 'center' }}><Price value={item.price_trend} currency={item.price_currency} /></div>
            {item.placementLabel && (
              <div style={{ fontSize: '0.55rem', color: '#ffc107', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.placementLabel}>{item.placementLabel}</div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(RecentScans);
