import { Activity, RefreshCw } from 'lucide-react';
import { currencySymbol } from '../utils/formatPrice';
import { useT } from '../utils/i18n';

const formatBytes = value => {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};

function AdminMetricsPanel({ metricsData, metricsError, metricsLoading, onRefresh }) {
  const { t, locale } = useT();
  if (!metricsData?.enabled && !metricsError) return null;

  const formatCount = value => Number(value || 0).toLocaleString(locale);
  const formatDuration = value => `${Number(value || 0).toLocaleString(locale, { maximumFractionDigits: 1 })} ms`;
  const formatValue = value => `${currencySymbol()}${Number(value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formatUptime = seconds => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return t('admin.metricsUptimeValue', { days, hours, minutes });
  };

  return (
    <section className="glass-panel" aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.metricsTitle')}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.3rem' }}>{t('admin.metricsHint')}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={metricsLoading}>
          <RefreshCw size={14} style={{ marginRight: '0.4rem' }} />
          {t('admin.metricsRefresh')}
        </button>
      </div>

      {metricsError ? (
        <div style={{ color: 'var(--accent-red)' }} role="alert">
          {metricsError}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh} style={{ marginLeft: '0.75rem' }}>
            {t('admin.metricsRefresh')}
          </button>
        </div>
      ) : metricsData?.enabled ? (
        <>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
            {t('admin.metricsSinceRestart', { uptime: formatUptime(metricsData.uptimeSeconds) })}
          </p>
          <div className="metrics-grid">
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsUsers')}</div>
              <div className="metric-value">{formatCount(metricsData.collection.userCount)}</div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsCards')}</div>
              <div className="metric-value">{formatCount(metricsData.collection.totalCards)}</div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsEntries')}</div>
              <div className="metric-value">{formatCount(metricsData.collection.uniqueCards)}</div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsValue')}</div>
              <div className="metric-value">{formatValue(metricsData.collection.totalValue)}</div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsAdded30d')}</div>
              <div className="metric-value">{formatCount(metricsData.collection.cardsAdded30d)}</div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsMemory')}</div>
              <div className="metric-value">{formatBytes(metricsData.memory.rss)}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {t('admin.metricsHeap')}: {formatBytes(metricsData.memory.heapUsed)}
              </div>
            </div>
            <div className="glass-panel metric-card">
              <div className="metric-header">{t('admin.metricsRequests')}</div>
              <div className="metric-value">{formatCount(metricsData.requests.calls)}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {t('admin.metricsRequestErrors')}: {formatCount(metricsData.requests.errors)}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                {t('admin.metricsAvgDuration')}: {formatDuration(metricsData.requests.averageDurationMs)}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '1rem', marginTop: '1rem' }}>
            <div>
              <h4 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('admin.metricsProviders')}</h4>
              <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>{t('admin.metricsProvider')}</th>
                      <th>{t('admin.metricsCalls')}</th>
                      <th>{t('admin.metricsRequestErrors')}</th>
                      <th>{t('admin.metricsAvgDuration')}</th>
                      <th>{t('admin.metricsMaxDuration')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricsData.providers.length ? metricsData.providers.map(provider => (
                      <tr key={provider.provider}>
                        <td>{provider.provider}</td>
                        <td>{formatCount(provider.calls)}</td>
                        <td>{formatCount(provider.errors)}</td>
                        <td>{formatDuration(provider.averageDurationMs)}</td>
                        <td>{formatDuration(provider.maxDurationMs)}</td>
                      </tr>
                    )) : <tr><td colSpan="5">{t('admin.metricsNoData')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h4 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('admin.metricsApiRoutes')}</h4>
              <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>{t('admin.metricsRoute')}</th>
                      <th>{t('admin.metricsCalls')}</th>
                      <th>{t('admin.metricsClientErrors')}</th>
                      <th>{t('admin.metricsServerErrors')}</th>
                      <th>{t('admin.metricsAvgDuration')}</th>
                      <th>{t('admin.metricsMaxDuration')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricsData.requests.routes.length ? metricsData.requests.routes.slice(0, 12).map(route => (
                      <tr key={route.route}>
                        <td><code>{route.route}</code></td>
                        <td>{formatCount(route.calls)}</td>
                        <td>{formatCount(route.clientErrors)}</td>
                        <td>{formatCount(route.serverErrors)}</td>
                        <td>{formatDuration(route.averageDurationMs)}</td>
                        <td>{formatDuration(route.maxDurationMs)}</td>
                      </tr>
                    )) : <tr><td colSpan="6">{t('admin.metricsNoData')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '1rem', marginTop: '1rem' }}>
            <div>
              <h4 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('admin.metricsByUser')}</h4>
              <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>{t('login.username')}</th>
                      <th>{t('admin.metricsCards')}</th>
                      <th>{t('admin.metricsEntries')}</th>
                      <th>{t('admin.metricsValue')}</th>
                      <th>{t('admin.metricsAdded30d')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricsData.collection.users.length ? metricsData.collection.users.map(collectionUser => (
                      <tr key={collectionUser.id}>
                        <td>{collectionUser.username}</td>
                        <td>{formatCount(collectionUser.total_cards)}</td>
                        <td>{formatCount(collectionUser.unique_cards)}</td>
                        <td>{formatValue(collectionUser.total_value)}</td>
                        <td>{formatCount(collectionUser.cards_added_30d)}</td>
                      </tr>
                    )) : <tr><td colSpan="5">{t('admin.metricsNoData')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h4 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('admin.metricsTypes')}</h4>
              <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>{t('login.username')}</th>
                      <th>{t('admin.metricsGame')}</th>
                      <th>{t('admin.metricsType')}</th>
                      <th>{t('admin.metricsCards')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricsData.collection.types.length ? metricsData.collection.types.map(type => (
                      <tr key={`${type.userId}-${type.game}-${type.name}`}>
                        <td>{type.username}</td>
                        <td>{type.game}</td>
                        <td>{type.name}</td>
                        <td>{formatCount(type.cards)}</td>
                      </tr>
                    )) : <tr><td colSpan="4">{t('admin.metricsNoData')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default AdminMetricsPanel;
