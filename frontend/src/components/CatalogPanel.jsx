import { useEffect, useRef, useState } from 'react';
import { Database, Play, Square, RefreshCw, Check, AlertTriangle, Cpu, Download, ListFilter, Languages, Zap } from 'lucide-react';
import SetTree from './SetTree';
import { useT } from '../utils/i18n';

// Scan catalogs.
//
// This replaced a panel that asked the user to reason about per-set ORB indexes,
// whole-game rollups, recall depth and set scoping in order to get a working
// scanner. There is one thing to build now — a catalog, which is one game in one
// language — and building it does both halves of the job:
//
//   1. cache every set's cards, so the app knows the cards exist at all
//   2. embed their artwork, so the scanner can recognise them
//
// Phase 1 is the one that used to be invisible. Card data was only ever cached as
// a side effect of building a scan index, so a set nobody indexed simply was not
// in the database — which is why Pokemon sat at 35% of the real card pool while
// looking, from the old panel, entirely built.
const GAME_LABEL = { mtg: 'Magic: The Gathering', pokemon: 'Pokémon', lorcana: 'Disney Lorcana' };
const POLL_MS = 1000;

// The house style, so this panel reads as part of Admin rather than its own app.
//
// It had grown a private type scale (0.6rem to 0.85rem, six sizes), pill badges
// nothing else uses, and hand-rolled inputs beside the shared .input-control —
// which is what "formatted differently from the rest of the menus" was. Everything
// below is lifted from the neighbouring admin panels: 1.1rem section head with an
// accent-red icon over a rule, 0.95rem sub-heads, 0.8rem body, the shared control
// classes, and .collection-table for anything that is a list of rows.
const H3 = { color: 'var(--text-strong)', fontSize: '1.1rem', margin: 0, borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' };
const H4 = { margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' };
const SUB = { background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' };
const INNER = { background: 'rgba(0, 0, 0, 0.18)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.75rem 0.9rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' };
const HINT = { color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.45 };
const NOTE = { color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0, lineHeight: 1.4 };
const ROW = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' };
const BTN = { display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0, height: '34px' };

function pct(a, b) {
  if (!b) return null;
  return Math.min(100, Math.round((a / b) * 100));
}

function Bar({ value, tone = 'var(--type-grass)' }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', background: tone, transition: 'width 0.3s' }} />
    </div>
  );
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const num = (n) => Number(n || 0).toLocaleString();

// An always-open sub-panel, for the things a user has to see rather than find.
//
// The engine and the ready-made catalogs were both <details> — the engine one
// collapsed as soon as the models were installed, and the ready-made list was a
// disclosure nested INSIDE it. So the two steps that get a scanner working in five
// minutes were two clicks deep, while the hours-long local build was the only
// thing on screen. That is backwards, and it is why installs sat unable to scan.
function Step({ n, icon, title, status, tone, children }) {
  return (
    <div style={SUB}>
      <div style={ROW}>
        <h4 style={H4}>{icon} {n}. {title}</h4>
        {status && <span style={{ fontSize: '0.8rem', fontWeight: 600, color: tone || 'var(--text-secondary)' }}>{status}</span>}
      </div>
      {children}
    </div>
  );
}

// Step one: the two model files. Nothing else on this screen does anything until
// they are installed, so this states that and offers the one button.
function EngineCard({ engine, onDownload, busy }) {
  const { t } = useT();
  if (!engine) return null;
  const models = engine.models || [];
  const missing = models.filter(m => !m.present);

  return (
    <Step
      n="1"
      icon={<Cpu size={16} style={{ color: 'var(--accent-red)' }} />}
      title={t('catalog.scanEngine')}
      status={missing.length ? t('catalog.requiredNotInstalled') : t('catalog.installed')}
      tone={missing.length ? 'var(--accent-yellow)' : 'var(--type-grass)'}
    >
      <div style={ROW}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: '1 1 20rem' }}>
          <p style={HINT}>
            {t('catalog.engineDesc', { size: mb(models.reduce((n, m) => n + m.bytes, 0)) })}
          </p>
          {/* Said plainly, because it is the reason this is a button at all. */}
          <p style={NOTE}>
            {t('catalog.engineLicense', { spdx: engine.license?.spdx || '' })}{' '}
            {(engine.license?.urls || []).map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-blue, #60a5fa)' }}>
                {i === 0 ? 'cornelius' : 'milo'}
              </a>
            )).reduce((acc, el) => acc.length ? [...acc, ', ', el] : [el], [])}
          </p>
        </div>
        {!!missing.length && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy}
            onClick={() => onDownload('models')} style={BTN}>
            <Download size={14} /> {t('catalog.download')}
          </button>
        )}
      </div>
    </Step>
  );
}

// Step two, and the answer for most installs: a published catalog is one download
// away from a working scanner, against the hours a local build takes. The
// tradeoffs are real and stated, but they are stated in a panel that is OPEN.
function ReadyMadeCard({ engine, onDownload, busy, enginePresent, productMap, onBuildMap }) {
  const { t } = useT();
  if (!engine) return null;
  const cats = engine.catalogs || [];
  if (!cats.length) return null;
  const have = cats.filter(c => c.present).length;
  const mapJob = productMap?.progress;
  const mapRows = productMap?.rows || 0;

  return (
    <Step
      n="2"
      icon={<Download size={16} style={{ color: 'var(--accent-red)' }} />}
      title={t('catalog.readyMadeTitle')}
      status={have ? t('catalog.nInstalled', { count: have }) : t('catalog.fastestWay')}
      tone={have ? 'var(--type-grass)' : 'var(--accent-blue, #60a5fa)'}
    >
      <p style={HINT}>
        {t('catalog.readyMadeDesc')}
      </p>
      {/* The two are NOT equivalent and shipping them as one row was the bug.
          Magic's published ids are Scryfall ids, so a hit fetches and caches the
          printing on the spot (routes/collection.js getCardById) — it works on a
          five-minute-old install with nothing downloaded. Pokémon's are TCGplayer
          product ids, which used to reach a card only via tcgplayer_product ->
          card_cache: two tables a fresh install has never filled, so every scan
          matched and then resolved to nothing. The product map is what closes that
          gap, and it downloads with the catalog. */}
      <p style={HINT}>
        <strong style={{ color: 'var(--text-strong)' }}>Magic</strong> {t('catalog.magicVsPokemon').split('Magic')[1]?.split('Pokémon')[0]?.trim()}
        {' '}<strong style={{ color: 'var(--text-strong)' }}>Pokémon</strong>{t('catalog.magicVsPokemon').split('Pokémon')[1]}
      </p>
      <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="collection-table">
          <thead>
            <tr>
              <th>{t('catalog.thGame')}</th>
              <th>{t('catalog.thSize')}</th>
              <th>{t('catalog.thSnapshot')}</th>
              <th style={{ textAlign: 'right' }}>{t('catalog.thStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(c => (
              <tr key={c.name}>
                <td style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{GAME_LABEL[c.game] || c.game}</td>
                <td>{mb(c.bytes)}</td>
                <td>{c.snapshot}</td>
                <td style={{ textAlign: 'right' }}>
                  {c.present
                    ? <span style={{ color: 'var(--type-grass)', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Check size={14} /> {t('catalog.installed')}</span>
                    : (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                        onClick={() => onDownload(`catalog:${c.game}`)}
                        style={{ ...BTN, marginLeft: 'auto' }}>
                        <Download size={14} /> {t('catalog.get')}
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!enginePresent && (
        <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
          {t('catalog.engineRequiredNote')}
        </p>
      )}

      {/* The Pokémon catalog's other half, and stated as such rather than as a
          separate feature: on its own it is the difference between a scan that
          names a card and one that names nothing. */}
      <div style={{ ...INNER, gap: '0.5rem' }}>
        <div style={ROW}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-strong)' }}>
            {t('catalog.productMapTitle')}
            <span style={{ fontWeight: 500, color: mapRows ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
              {' · '}{mapJob ? t('catalog.productMapBuilding') : mapRows ? t('catalog.productMapMapped', { count: num(mapRows) }) : t('catalog.productMapNotBuilt')}
            </span>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!!mapJob}
            onClick={onBuildMap} style={BTN}>
            <RefreshCw size={14} /> {mapJob ? t('catalog.btnBuilding') : mapRows ? t('catalog.btnRefresh') : t('catalog.btnBuild')}
          </button>
        </div>
        <p style={NOTE}>
          {t('catalog.productMapDesc')}
        </p>
        {mapJob && (
          <>
            <div style={{ ...ROW, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span>{mapJob.phase === 'groups' ? t('catalog.listingSets') : mapJob.message || t('catalog.readingSets')}</span>
              <span>{t('catalog.productMapCardsCount', { done: mapJob.done, total: mapJob.total || '?', cards: num(mapJob.rows) })}</span>
            </div>
            <Bar value={pct(mapJob.done, mapJob.total) ?? 0} tone="var(--accent-blue, #60a5fa)" />
          </>
        )}
        {!mapJob && productMap?.last?.phase === 'error' && (
          <p style={{ ...NOTE, color: 'var(--accent-red)' }}>{t('catalog.lastBuildFailed', { message: productMap.last.message })}</p>
        )}
      </div>
    </Step>
  );
}

// Pick the sets to build, instead of committing to a whole game.
//
// This is the difference between minutes and hours: a full MTG build is a ~10
// minute set walk plus ~110k embeddings, while the two boxes actually in front of
// you are a couple of minutes. Scoped builds MERGE (see catalog.js keptFromPrev),
// so this is additive — build what you opened this week, build more next week.
function BuildPicker({ game, lang, disabled, onBuild, showToast, label }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState([]);
  const [counts, setCounts] = useState(null);
  const [picked, setPicked] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const codeOf = (s) => game === 'mtg' ? (s.ptcgo_code || (s.id || '').replace(/^mtg-/, '')) : s.id;

  useEffect(() => {
    if (!open || sets.length) return;
    setLoading(true);
    const l = encodeURIComponent(lang);
    Promise.all([
      fetch(`/api/sets?game=${game}&lang=${l}&tree=1`).then(r => r.ok ? r.json() : []),
      fetch(`/api/scan-sets?game=${game}&lang=${l}`).then(r => r.ok ? r.json() : null),
    ]).then(([tree, sc]) => {
      setSets(tree);
      setCounts(sc?.sets || null);
    }).catch(() => showToast?.(t('catalog.errListSets')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const has = (code) => picked.some(c => c.toLowerCase() === String(code).toLowerCase());
  const drop = (arr, codes) => {
    const gone = new Set(codes.map(c => String(c).toLowerCase()));
    return arr.filter(c => !gone.has(c.toLowerCase()));
  };
  const toggleCode = (code) => setPicked(p => has(code) ? drop(p, [code]) : [...p, code]);
  const toggleFamily = (s) => {
    const code = codeOf(s);
    const kids = (s.children || []).map(c => c.code);
    setPicked(p => has(code) ? drop(p, [code, ...kids]) : [...drop(p, [code, ...kids]), code, ...kids]);
  };

  // Closed, this is the RECOMMENDED action rather than an afterthought next to
  // "Build all": picking the sets you actually own is minutes of work, and a whole
  // game is hours. It used to be a secondary button labelled "Build only certain
  // sets", which reads like a restriction on the obvious choice instead of the
  // cheaper one.
  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled}
        onClick={() => setOpen(true)} style={BTN}>
        <ListFilter size={14} /> {label || t('catalog.chooseSets')}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', width: '100%', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
      <div style={ROW}>
        <p style={{ ...HINT, flex: '1 1 18rem' }}>
          {picked.length
            ? t('catalog.setsSelected', { count: picked.length })
            : t('catalog.setsSelectHint')}
        </p>
        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
          {!!picked.length && (
            <button type="button" className="btn btn-secondary btn-sm" style={BTN}
              onClick={() => setPicked([])}>{t('bulk.clear')}</button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" style={BTN}
            onClick={() => { setOpen(false); setPicked([]); setQuery(''); }}>{t('common.cancel')}</button>
        </div>
      </div>
      <input
        type="text"
        className="input-control"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={game === 'mtg' ? t('catalog.searchMtgPlaceholder') : t('catalog.searchPokemonPlaceholder')}
        style={{ padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
      />
      {loading
        ? <p style={HINT}>{t('catalog.loadingSets')}</p>
        : (
          <SetTree
            sets={[...sets].reverse()}
            codeOf={codeOf}
            selected={picked}
            onToggleCode={toggleCode}
            onToggleFamily={toggleFamily}
            counts={counts}
            showCounts={!!counts}
            query={query}
            maxHeight={220}
            emptyLabel={t('scan.noSetMatches')}
          />
        )}
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !picked.length}
        onClick={() => { onBuild(picked); setOpen(false); setPicked([]); setQuery(''); }}
        style={{ ...BTN, alignSelf: 'flex-start' }}>
        <Play size={14} /> {t('catalog.buildNSelected', { count: picked.length || '' })}
      </button>
    </div>
  );
}

// Other languages — only the ones that exist to download, with the numbers.
//
// Pokémon only, and the copy says why: Magic IS printed in every language on this
// list and Scryfall serves all of them, but a non-English MTG catalog would be a
// copy of the English one. The scanner matches ARTWORK, and a localized Magic
// printing is the same set with the same illustration — so the English catalog
// already identifies a Japanese card and the scan result is re-expressed by set and number
// (cvScan.loadAll). Japanese Pokémon is the opposite case: whole sets that never
// released in English, which nothing in the English catalog can match.
//
// The list is fetched once, on open. /api/admin/catalogs is polled every second
// during a build and this costs a provider set list per language, so the two are
// deliberately separate endpoints.
function OtherLanguages({ disabled, onBuild, showToast }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [langs, setLangs] = useState(null);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState(null);

  useEffect(() => {
    if (!open || langs) return;
    fetch('/api/admin/catalogs/languages?game=pokemon')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => setLangs(j.languages || []))
      .catch(e => { setError(e.message); showToast?.(t('catalog.errListLangs')); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary style={{ cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)', padding: '0.4rem 0', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Languages size={15} /> {t('catalog.otherLanguages')}
      </summary>
      <div style={{ ...INNER, marginTop: '0.5rem' }}>
        <p style={HINT}>
          {t('catalog.otherLangsDesc')}
        </p>
        {error && <p style={{ ...NOTE, color: 'var(--accent-red)' }}>{t('catalog.errLanguageList', { error })}</p>}
        {!langs && !error && <p style={HINT}>{t('catalog.askingProvider')}</p>}
        {!!langs?.length && (
          <>
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>{t('prefs.language')}</th>
                    <th>{t('catalog.thCardsIndexable')}</th>
                    <th>{t('catalog.thSets')}</th>
                    <th>{t('catalog.thCatalog')}</th>
                    <th style={{ textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {langs.map(l => (
                    <tr key={l.lang} style={pick === l.lang ? { background: 'rgba(255,71,71,0.06)' } : undefined}>
                      <td style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{l.lang}</td>
                      {/* withArt, not cached: a card with no artwork can never be
                          embedded, so it is not a card we can index. */}
                      <td>
                        {num(l.withArt)} of {num(l.claimed)}
                        {l.claimed ? <span style={{ color: 'var(--text-muted)' }}> · {pct(l.withArt, l.claimed)}%</span> : null}
                      </td>
                      <td>{num(l.sets)}</td>
                      <td style={{ color: l.built ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
                        {l.built ? t('catalog.nIndexed', { count: num(l.built.rows) }) : t('catalog.productMapNotBuilt')}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled}
                          onClick={() => setPick(p => p === l.lang ? null : l.lang)}
                          style={{ ...BTN, marginLeft: 'auto' }}>
                          {pick === l.lang ? t('catalog.selected') : t('catalog.select')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={NOTE}>
              {t('catalog.cardsIndexableDesc')}
            </p>
            {pick && (
              <div style={{ ...ROW, borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-strong)' }}>
                  Pokémon · {pick}
                </span>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {/* Keyed so switching language resets the set list rather than
                      showing the previous language's sets. */}
                  <BuildPicker
                    key={pick}
                    game="pokemon"
                    lang={pick}
                    disabled={disabled}
                    onBuild={(sets) => onBuild('pokemon', pick, sets)}
                    showToast={showToast}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={disabled}
                    onClick={() => onBuild('pokemon', pick)} style={BTN}>
                    <Play size={14} /> {t('catalog.buildEverySet')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {langs && !langs.length && !error && (
          <p style={HINT}>{t('catalog.noOtherLanguages')}</p>
        )}
      </div>
    </details>
  );
}

export default function CatalogPanel({ showToast }) {
  const { t } = useT();
  const [catalogs, setCatalogs] = useState([]);
  const [progress, setProgress] = useState(null);
  const [last, setLast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [engine, setEngine] = useState(null);
  const timer = useRef(null);

  const load = async () => {
    try {
      const r = await fetch('/api/admin/catalogs');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setCatalogs(j.catalogs || []);
      setProgress(j.progress || null);
      setLast(j.last || null);
      // Engine state is a separate read: it is filesystem + byte sizes, nothing to
      // do with the database counts above.
      try {
        const e = await fetch('/api/admin/models');
        if (e.ok) setEngine(await e.json());
      } catch { /* the panel still lists catalogs without it */ }
    } catch (e) {
      showToast?.(t('catalog.errLoadCatalogs', { message: e.message }));
    } finally {
      setLoading(false);
    }
  };

  // Poll only while something is running. A build is minutes-to-hours of work, so
  // the panel is usually idle and a permanent 1s poll would be pure noise.
  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One timer for both jobs. A build and a download are never both running (each
  // refuses while the other holds its slot), so a single poll covers whichever is.
  useEffect(() => {
    clearTimeout(timer.current);
    // The product map is a third job with its own progress, and it is STARTED by a
    // catalog download finishing — so the poll has to survive the download it
    // followed, or the bar freezes mid-build until the panel is reopened.
    if (!progress && !engine?.progress && !engine?.productMap?.progress) return;
    timer.current = setTimeout(async () => {
      try {
        if (progress) {
          const r = await fetch('/api/admin/catalogs/progress');
          const j = await r.json();
          setProgress(j.progress || null);
          setLast(j.last || null);
          // A build that just finished changes the row counts, so refresh the list.
          if (!j.progress) load();
        }
        if (engine?.progress || engine?.productMap?.progress) {
          const e = await fetch('/api/admin/models');
          if (e.ok) {
            const ej = await e.json();
            setEngine(ej);
            // A finished download changes what is installed, and a downloaded
            // catalog changes what the list reports as published.
            if (!ej.progress && !ej.productMap?.progress) load();
          }
        }
      } catch { /* a dropped poll is not worth surfacing; the next one retries */ }
    }, POLL_MS);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, engine?.progress, engine?.productMap?.progress]);

  const download = async (what) => {
    try {
      const r = await fetch('/api/admin/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what }),
      });
      const j = await r.json();
      if (!r.ok) return showToast?.(j.error || t('catalog.errStartDownloadGeneric'));
      setEngine(prev => ({ ...(prev || {}), progress: j.progress }));
    } catch (e) {
      showToast?.(t('catalog.errStartDownload', { message: e.message }));
    }
  };

  // Normally started by the Pokémon catalog download itself; this is the refresh
  // after a set release, or a retry when a run died halfway.
  const buildProductMap = async () => {
    try {
      const r = await fetch('/api/admin/models/product-map', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) return showToast?.(j.error || t('catalog.errStartProductMapGeneric'));
      setEngine(prev => ({ ...(prev || {}), productMap: { ...(prev?.productMap || {}), progress: j.progress } }));
    } catch (e) {
      showToast?.(t('catalog.errStartProductMap', { message: e.message }));
    }
  };

  // `sets` scopes the build. A scoped build MERGES into the existing catalog, so
  // building the two sets you just opened does not discard last week's work.
  const build = async (game, lang, sets = []) => {
    try {
      const r = await fetch('/api/admin/catalogs/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, lang, sets }),
      });
      const j = await r.json();
      if (!r.ok) return showToast?.(j.error || t('catalog.errStartBuildGeneric'));
      setProgress(j.progress);
    } catch (e) {
      showToast?.(t('catalog.errStartBuild', { message: e.message }));
    }
  };

  const stop = async () => {
    try {
      const r = await fetch('/api/admin/catalogs/stop', { method: 'POST' });
      const j = await r.json();
      setProgress(j.progress);
      showToast?.(t('catalog.stoppingToast'));
    } catch (e) {
      showToast?.(t('catalog.errStop', { message: e.message }));
    }
  };

  const running = progress;

  // English rows only, plus any language that has a catalog of its OWN.
  //
  // Deliberately NOT keyed on `published`: cvScan.isBuilt falls back to the English
  // catalog for any language, so that flag is true for every row and means
  // 'something can answer', not 'this language is built'. The languages this
  // install merely holds a card or two of are not rows at all any more — they were
  // fifteen near-empty entries invented by one imported card each, and the ones
  // worth building now live in OtherLanguages with their real numbers.
  const rows = catalogs.filter(c => !!c.built || c.lang === 'English');

  // One collapsed line per catalog. The summary carries everything needed to decide
  // whether to open it — state, counts, and any warning — because a row that hides
  // "cards from 46 sets will be misidentified" behind a click is worse than the wall
  // of rows this replaced.
  const renderRow = (c) => {
    // Only English has a real denominator — the set catalogue is one list, not one
    // per language — so other languages report what they hold rather than a
    // percentage measured against the wrong total.
    const coverage = c.claimed ? pct(c.cached, c.claimed) : null;
    const indexed = c.built ? c.built.rows : 0;
    const busy = running && running.game === c.game && running.lang === c.lang;
    const indexable = c.withArt ?? c.cached;
    const warn = (c.built && indexable > indexed) || !!c.newSets;
    return (
      <details key={`${c.game}|${c.lang}`} style={INNER}>
        <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)' }}>
            {GAME_LABEL[c.game] || c.game}
            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}> · {c.lang}</span>
          </span>
          <span style={{ fontSize: '0.8rem', color: c.built ? 'var(--type-grass)' : 'var(--text-secondary)' }}>
            {c.built ? t('catalog.nIndexed', { count: num(indexed) }) : c.published ? t('catalog.readyMadeInUse') : t('catalog.productMapNotBuilt')}
          </span>
          {warn && <AlertTriangle size={14} color="var(--accent-yellow)" />}
        </summary>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', paddingTop: '0.75rem' }}>
          <p style={HINT}>
            {c.claimed
              ? t('catalog.nOfKnownDownloaded', { cached: num(c.cached), claimed: num(c.claimed) })
              : t('catalog.nDownloaded', { cached: num(c.cached) })}
          </p>
          {coverage != null && <Bar value={coverage} />}
          {/* Picking sets comes FIRST and is the primary button; the whole-game
              build is the expensive fallback and now says so. The two used to be
              the other way round, with "Build all" the only visible action and the
              set picker hidden behind a secondary button below it — so the default
              path was the one that takes hours. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <BuildPicker
              game={c.game}
              lang={c.lang}
              disabled={!!running}
              onBuild={(sets) => build(c.game, c.lang, sets)}
              showToast={showToast}
            />
            <button
              type="button"
              className={warn ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              disabled={!!running}
              onClick={() => build(c.game, c.lang)}
              style={BTN}
            >
              {c.built ? <RefreshCw size={14} /> : <Play size={14} />}
              {busy ? t('catalog.btnBuilding') : c.built ? t('catalog.updateEverythingBuilt') : t('catalog.buildWholeGame')}
            </button>
            {!c.built && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t('catalog.wholeGameHint')}
              </span>
            )}
          </div>
          {/* The number that actually predicts whether a scan can answer: a catalog
              can be perfectly built and still only cover the cards this install has
              downloaded. */}
          {/* withArt, not cached: a card with no artwork can never be embedded, so
              counting it here told the user to re-run a build that would change
              nothing. Measured: 68 by the old count, 53 of which were real — the
              other 15 have no image at all. */}
          {c.built && indexable > indexed && (
            <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
              {t('catalog.notIndexedYet', { count: num(indexable - indexed) })}
            </p>
          )}
          {/* The warning above compares downloaded against indexed, so it stays
              silent for a set released since the last build: those cards are not
              downloaded either. Scanning one returns the nearest wrong card. */}
          {/* Sets a build has already found to be empty upstream are excluded by the
              backend, so what is left really is buildable. Before that, this counted
              46 unbuildable promo/sample sets and told the user to build them. */}
          {!!c.newSets && (
            <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
              {t('catalog.newSetsWarning', { count: num(c.newSets) })}
            </p>
          )}
        </div>
      </details>
    );
  };

  if (loading) return <p style={{ ...HINT, padding: '0.5rem 0' }}>{t('catalog.loadingCatalogs')}</p>;

  const phaseLabel = running && (running.phase === 'cache'
    ? t('catalog.downloadingCardLists')
    : running.phase === 'embed' ? t('catalog.buildingImageIndex') : running.phase);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <h3 style={H3}>
        <Database size={18} style={{ color: 'var(--accent-red)' }} />
        {t('catalog.title')}
      </h3>
      <p style={HINT}>
        {t('catalog.intro')}
      </p>

      <EngineCard
        engine={engine}
        onDownload={download}
        busy={!!engine?.progress || !!running}
      />

      <ReadyMadeCard
        engine={engine}
        onDownload={download}
        busy={!!engine?.progress || !!running}
        enginePresent={!(engine?.models || []).some(m => !m.present)}
        productMap={engine?.productMap}
        onBuildMap={buildProductMap}
      />

      {/* One progress bar for both downloads: models and published catalogs share a
          single slot on the server, so only one of them can ever be running. */}
      {engine?.progress && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div style={{ ...ROW, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>{engine.progress.phase === 'error' ? engine.progress.message : t('catalog.downloadingWithName', { name: engine.progress.name })}</span>
            <span>{mb(engine.progress.done)} / {mb(engine.progress.total)}</span>
          </div>
          <Bar value={pct(engine.progress.done, engine.progress.total) ?? 0} tone="var(--accent-blue, #60a5fa)" />
        </div>
      )}

      {/* Same <Step> as 1 and 2 — head, status on the right, one bordered box. It
          was a bare h4 with the note inline, which put the third step in a different
          visual class from the two above it. */}
      <Step
        n="3"
        icon={<Database size={16} style={{ color: 'var(--accent-red)' }} />}
        title={t('catalog.buildYourOwn')}
        status={t('catalog.buildYourOwnStatus')}
      >
        <p style={HINT}>
          {t('catalog.buildYourOwnDesc')}
        </p>
        {/* The speed argument, with the numbers, because it is the one benefit
            nobody can see from this panel. A ready-made catalog names cards by a
            PROVIDER id, so a scan of a card this install has never cached has to
            fetch it before it can show anything. A local catalog is keyed by
            card_cache ids, so the same step is a primary-key read. */}
        <div style={{ ...INNER, flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}>
          <Zap size={15} style={{ color: 'var(--accent-blue, #60a5fa)', flexShrink: 0, marginTop: '0.1rem' }} />
          <p style={{ ...HINT, flex: 1 }}>
            <strong style={{ color: 'var(--text-strong)' }}>{t('catalog.speedTitle')}</strong>{' '}
            {t('catalog.speedDesc')}
          </p>
        </div>

        {running && (
          <div style={INNER}>
            <div style={ROW}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)' }}>
                {GAME_LABEL[running.game] || running.game} · {running.lang}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={stop} disabled={running.cancelled}
                style={BTN}>
                <Square size={14} /> {running.cancelled ? t('catalog.stopping') : t('common.stop')}
              </button>
            </div>
            <div style={{ ...ROW, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span>{phaseLabel}{running.message ? ` · ${running.message}` : ''}</span>
              <span>{running.done}/{running.total || '?'}</span>
            </div>
            <Bar value={pct(running.done, running.total) ?? 0} tone="var(--accent-red)" />
          </div>
        )}

        {!running && last && (
          <p style={{ ...HINT, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {last.phase === 'error'
              ? <><AlertTriangle size={15} color="var(--accent-red)" /> {t('catalog.lastBuildFailed', { message: last.message })}</>
              : <><Check size={15} color="var(--type-grass)" /> {GAME_LABEL[last.game] || last.game} · {last.lang}: {last.message}</>}
          </p>
        )}

        {rows.map(renderRow)}

        <OtherLanguages disabled={!!running} onBuild={build} showToast={showToast} />
      </Step>
    </div>
  );
}
