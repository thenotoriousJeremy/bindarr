import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, ArrowRight, Undo2 } from 'lucide-react';
import { useT } from '../utils/i18n';

// pokemontcg.io stops serving on 1 March 2027, and every card an install collected
// from it is keyed by its ids. This is the admin's way off them: a dry run that
// says what would move and what cannot, a confirmed migrate, and an undo. The
// backend (pokemonMigration.js) does the work; this only reports and asks.
const API = '/api/admin/pokemon-migration';
const POLL_MS = 1500;
const PANEL = { borderLeft: '3px solid var(--accent-yellow)', display: 'flex', flexDirection: 'column', gap: '0.85rem' };
const HINT = { color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.45 };
const ROW = { display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' };
const BTN = { display: 'flex', alignItems: 'center', gap: '0.4rem', height: '34px' };
const STAT = { background: 'rgba(0, 0, 0, 0.18)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', minWidth: '9rem' };

const providerName = (t, p) => t(`migration.provider.${p}`);

// Same check CardArtEditor uses: advisory only, the endpoints enforce admin.
function isAdmin() {
  try {
    return JSON.parse(localStorage.getItem('bindarr_user') || 'null')?.role === 'admin';
  } catch {
    return false;
  }
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function useMigrationStatus(enabled) {
  const [status, setStatus] = useState(null);
  const live = useRef(true);
  const load = useCallback(async () => {
    if (!enabled) return null;
    try {
      const res = await fetch(`${API}/status`);
      if (!res.ok) return null;
      const data = await res.json();
      if (live.current) setStatus(data);
      return data;
    } catch {
      return null;
    }
  }, [enabled]);
  useEffect(() => {
    live.current = true;
    load();
    return () => { live.current = false; };
  }, [load]);
  return [status, load];
}

// Dashboard: one line for admins while ids are left, pointing at Admin.
export function PokemonMigrationNotice({ onNavigate }) {
  const { t } = useT();
  const [status] = useMigrationStatus(isAdmin());
  if (!status || !status.pending || status.pending.ids === 0) return null;
  return (
    <div className="glass-panel" style={{ ...PANEL, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: '1rem', padding: '0.85rem 1.1rem' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <AlertTriangle size={16} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
        {t('migration.notice', { count: status.pending.ids, date: status.sunset, days: status.days_left })}
      </span>
      {onNavigate && (
        <button type="button" className="btn btn-secondary btn-sm" style={BTN} onClick={() => onNavigate('admin')}>
          {t('migration.review')} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

function Counts({ report }) {
  const { t } = useT();
  const c = report.counts;
  const items = [['countMapped', c.mapped], ['countProduct', c.product], ['countAmbiguous', c.ambiguous], ['countUnmapped', c.unmapped]];
  return (
    <div style={ROW}>
      {items.map(([key, n]) => (
        <div key={key} style={STAT}>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-strong)' }}>{n}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t(`migration.${key}`)}</div>
        </div>
      ))}
    </div>
  );
}

function Unresolved({ items }) {
  const { t } = useT();
  return (
    <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
      <table className="collection-table">
        <thead>
          <tr>
            <th>{t('migration.colCard')}</th>
            <th>{t('migration.colSet')}</th>
            <th>{t('migration.colReason')}</th>
            <th className="hide-mobile">{t('migration.colOwners')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(u => (
            <tr key={u.old_id}>
              <td>
                <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{u.name || u.old_id}</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{u.old_id}</div>
              </td>
              <td style={{ fontSize: '0.8rem' }}>{u.set_name || u.set_id} #{u.number}</td>
              <td style={{ fontSize: '0.8rem' }}>
                {t(`migration.reason.${u.reason}`)}
                {u.candidates.length > 0 && (
                  <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {u.candidates.map(c => c.id).join(', ')}
                  </div>
                )}
              </td>
              <td className="hide-mobile" style={{ fontSize: '0.8rem' }}>
                {u.owners.map(o => t('migration.owner', { name: o.username || `#${o.user_id}`, count: o.collection_rows + o.deck_rows })).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Admin: the full panel. Shown while ids are left, while a run is still
// refreshing, and after a run (with undo) until there is nothing left to say.
export default function PokemonMigrationBanner({ showToast, onProviderChanged }) {
  const { t, locale } = useT();
  const [status, reload] = useMigrationStatus(true);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null); // 'preview' | 'apply' | 'revert'
  const [showList, setShowList] = useState(false);
  const [result, setResult] = useState(null);

  const following = status?.follow_up && !status.follow_up.finished_at;
  useEffect(() => {
    if (!following) return undefined;
    const timer = setInterval(async () => {
      const next = await reload();
      if (next && next.follow_up?.finished_at) onProviderChanged?.();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [following, reload, onProviderChanged]);

  const preview = async () => {
    setBusy('preview');
    try {
      const res = await fetch(`${API}/preview`);
      const data = await readJson(res);
      if (res.ok) { setReport(data); setResult(null); }
      else showToast(data.error || t('migration.errPreview'));
    } catch {
      showToast(t('migration.errPreview'));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    const target = providerName(t, report.target_provider);
    if (!window.confirm(t('migration.confirm', { count: report.counts.migratable, target }))) return;
    setBusy('apply');
    try {
      const res = await fetch(`${API}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: report.plan_id }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        showToast(data.error || t('migration.errApply'));
        return;
      }
      setResult(data);
      setReport(null);
      if (data.run) showToast(t('migration.done', { count: data.run.summary?.ids || 0, file: data.run.backup_file || '' }));
      await reload();
      onProviderChanged?.();
    } catch {
      showToast(t('migration.errApply'));
    } finally {
      setBusy(null);
    }
  };

  const revert = async (run) => {
    if (!window.confirm(t('migration.confirmUndo', { date: new Date(`${run.applied_at}Z`).toLocaleString(locale) }))) return;
    setBusy('revert');
    try {
      const res = await fetch(`${API}/revert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: run.id }),
      });
      const data = await readJson(res);
      if (!res.ok) showToast(data.error || t('migration.errUndo'));
      else showToast(t('migration.undone'));
      setResult(null);
      setReport(null);
      await reload();
      onProviderChanged?.();
    } catch {
      showToast(t('migration.errUndo'));
    } finally {
      setBusy(null);
    }
  };

  if (!status) return null;
  const lastRun = (status.runs || []).find(r => !r.reverted_at) || null;
  if (!status.pending.ids && !following && !lastRun && !report) return null;
  const target = providerName(t, status.target_provider);
  const follow = status.follow_up;

  return (
    <div className="glass-panel" style={PANEL}>
      <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <AlertTriangle size={18} style={{ color: 'var(--accent-yellow)' }} />
        {t('migration.title', { date: status.sunset })}
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-yellow)' }}>{t('migration.daysLeft', { count: status.days_left })}</span>
      </h3>

      {status.pending.ids > 0 ? (
        <>
          <p style={HINT}>{t('migration.pending', { ids: status.pending.ids, rows: status.pending.collection_rows, users: status.pending.users })}</p>
          <p style={HINT}>{t('migration.explain', { target })}</p>
          {status.configured_provider !== status.target_provider && <p style={HINT}>{t('migration.switchesProvider', { target })}</p>}
        </>
      ) : (
        <p style={HINT}>{t('migration.nothingToDo')}</p>
      )}

      {following && (
        <p style={HINT}>
          <RefreshCw size={12} className="spin-animation" style={{ marginRight: '0.35rem' }} />
          {follow.phase === 'hydrating'
            ? t('migration.hydrating', { target, done: follow.done, total: follow.total })
            : t('migration.finishing')}
        </p>
      )}
      {!following && follow?.failed > 0 && <p style={HINT}>{t('migration.hydrateFailed', { count: follow.failed })}</p>}

      {report && (
        <>
          <Counts report={report} />
          <p style={HINT}>{t('migration.rows', { collection: report.rows.collection || 0, decks: report.rows.deck_cards || 0, history: report.rows.price_history || 0 })}</p>
          {report.storage.changes > 0 && <p style={HINT}>{t('migration.storage', { count: report.storage.changes })}</p>}
          {report.errors.length > 0 && <p style={HINT}>{t('migration.errors', { count: report.errors.length, target })}</p>}
          {report.examples.length > 0 && (
            <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {report.examples.slice(0, 5).map(e => <div key={e.old_id}>{e.old_id} → {e.new_id}</div>)}
            </div>
          )}
        </>
      )}

      <div style={ROW}>
        {status.pending.ids > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" style={BTN} onClick={preview} disabled={!!busy || following}>
            <RefreshCw size={14} className={busy === 'preview' ? 'spin-animation' : ''} />
            {busy === 'preview' ? t('migration.previewing', { target }) : t(report ? 'migration.refresh' : 'migration.preview')}
          </button>
        )}
        {report && report.counts.migratable > 0 && (
          <button type="button" className="btn btn-primary btn-sm" style={BTN} onClick={apply} disabled={!!busy || following}>
            {busy === 'apply' ? t('migration.applying') : t('migration.migrate', { count: report.counts.migratable })}
          </button>
        )}
        {report && report.unresolved.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" style={BTN} onClick={() => setShowList(v => !v)}>
            {showList ? t('migration.hideUnresolved') : t('migration.showUnresolved', { count: report.unresolved.length })}
          </button>
        )}
        {lastRun && !report && (
          <button type="button" className="btn btn-secondary btn-sm" style={BTN} onClick={() => revert(lastRun)} disabled={!!busy || following}>
            <Undo2 size={14} /> {t('migration.undo')}
          </button>
        )}
      </div>

      {result?.noop && <p style={HINT}>{t('migration.noop')}</p>}
      {lastRun && !report && (
        <p style={{ ...HINT, color: 'var(--text-muted)' }}>
          {t('migration.lastRun', { count: lastRun.summary?.ids || 0, date: new Date(`${lastRun.applied_at}Z`).toLocaleString(locale), file: lastRun.backup_file || '' })}
        </p>
      )}
      {report && showList && <Unresolved items={report.unresolved} />}
    </div>
  );
}
