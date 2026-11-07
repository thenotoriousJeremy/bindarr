import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, RefreshCw, ShoppingCart, Heart } from 'lucide-react';
import CardImage from './CardImage';
import CardImageZoom from './CardImageZoom';
import { useT } from '../utils/i18n';
import { priceText } from '../utils/formatPrice';
import { defaultGame, gameOptions, showGamePicker } from '../utils/games';
import { getLanguagesForGame, displayName } from '../utils/languages';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { filterCards, isComplete, purchaseList, valueParts } from '../utils/setCompletion';
import { buildMassEntry, massEntryPage } from '../utils/tcgMassEntryUrl';

// Every card in one set, owned or not (GET /api/set-completion).
//
// Owned cards are in full colour with the number of copies; missing ones are
// greyed out with their price, so the gaps in a binder can be read at a glance.
// The counting is the server's: this view only switches between its two answers
// (cards, or every printing of every card for a Pokémon master set) and filters.
//
// `focusSet` ({ setId, game?, lang? }) is how the dashboard's set-progress list
// opens a set here; a new object each time, so the same set can be reopened.
export default function SetCompletion({ focusSet, statsTrigger, showToast }) {
  const { t } = useT();
  const [game, setGame] = useState(() => defaultGame());
  const [lang, setLang] = useState('en');
  const [sets, setSets] = useState([]);
  const [mySets, setMySets] = useState([]);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [show, setShow] = useState('all');
  const [variants, setVariants] = useState(false);
  const [zoom, setZoom] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    if (focusSet && focusSet.setId) {
      setTarget({ set: focusSet.setId, game: focusSet.game || null, lang: focusSet.lang || null });
    }
  }, [focusSet]);

  // The game's whole set list, for the picker. Per language for Pokémon: Japan
  // has sets the West never sees.
  useEffect(() => {
    let cancelled = false;
    setSets([]);
    fetch(`/api/sets?game=${game}&lang=${encodeURIComponent(lang)}`)
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setSets(Array.isArray(rows) ? rows.filter(s => !s.game || s.game === game) : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [game, lang]);

  // Sets the user owns cards from, most-collected first.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/set-completion/sets?game=${game}`)
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setMySets(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [game, statsTrigger]);

  const load = useCallback(async (tgt, { refresh = false } = {}) => {
    if (!tgt) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ set: tgt.set });
    if (tgt.game) params.set('game', tgt.game);
    if (tgt.lang) params.set('lang', tgt.lang);
    if (refresh) params.set('refresh', '1');
    try {
      const res = await fetch(`/api/set-completion?${params}`);
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(body.error || t('sets.errLoad'));
      setData(body);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err.message || t('sets.errLoad'));
      setData(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [t]);

  // Reloaded when something was added elsewhere, so the grid fills in as cards
  // are scanned. The listing is cached server-side; only ownership is re-read.
  useEffect(() => { load(target); }, [target, statsTrigger, load]);

  // A bare dashboard link learns its game and language from the answer.
  useEffect(() => {
    if (!data) return;
    if (data.game) setGame(data.game);
    if (data.lang) setLang(data.lang);
    if (!data.summary || !data.summary.variants) setVariants(false);
  }, [data]);

  const pick = (s) => {
    setTarget({ set: s.id, game, lang: s.lang || lang });
    setQuery('');
    setPickerOpen(false);
    setShow('all');
  };

  const changeGame = (g) => {
    if (g === game) return;
    setGame(g);
    setLang('en');
    setTarget(null);
    setData(null);
    setError(null);
  };

  const changeLang = (code) => {
    setLang(code);
    setTarget(null);
    setData(null);
    setError(null);
  };

  const q = query.trim().toLowerCase();
  const hit = (...values) => !q || values.some(v => String(v || '').toLowerCase().includes(q));
  const myMatches = mySets.filter(s => hit(s.set_id, s.set_name)).slice(0, 12);
  // The set list arrives oldest first; the newest are what people are completing.
  const allMatches = sets.filter(s => hit(s.id, s.name, s.ptcgo_code)).slice(-60).reverse();

  const variantView = variants && !!(data && data.summary && data.summary.variants);
  const summary = data ? (variantView ? data.summary.variants : data.summary.cards) : null;
  const shown = data ? filterCards(data.cards, { show, variants: variantView }) : [];
  const parts = summary ? valueParts(summary.missing_value) : [];

  const buyMissing = () => {
    if (!data) return;
    const items = purchaseList(data.cards, { variants: variantView, setCode: data.set.tcgplayer_set_code || null });
    if (!items.length) { showToast(t('sets.nothingMissing')); return; }
    const { url, text } = buildMassEntry(items, { game: data.game, language: data.lang });
    if (url) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    // Too long for a link: the list goes on the clipboard and the page opens empty.
    const copy = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
    copy.then(() => showToast(t('massEntry.copied'))).catch(() => showToast(t('massEntry.copyFailed')));
    window.open(massEntryPage(data.game, data.lang), '_blank', 'noopener');
  };

  const setCodeShown = data ? String(data.set.id || '').replace(/^(mtg|lorcana|riftbound)-/, '').toUpperCase() : '';
  const art = data ? (data.set.logo_url || data.set.symbol_url) : null;

  return (
    <div>
      {showGamePicker() && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
          <div className="sub-nav-tabs" style={{ margin: 0 }}>
            {gameOptions().map(g => (
              <button
                key={g.value}
                type="button"
                className={`sub-nav-tab ${game === g.value ? 'active' : ''}`}
                style={{ padding: '0.35rem 0.85rem', fontSize: '0.75rem' }}
                onClick={() => changeGame(g.value)}
              >
                {g.short}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Set picker */}
      <div className="glass-panel" style={{ marginBottom: '1.25rem', padding: '1rem 1.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ marginBottom: 0, flex: '1 1 260px', position: 'relative' }}>
          <label htmlFor="set-completion-search">{t('sets.pickLabel')}</label>
          <div style={{ position: 'relative' }}>
            <input
              id="set-completion-search"
              type="text"
              className="input-control"
              autoComplete="off"
              placeholder={t('sets.pickPlaceholder')}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPickerOpen(true); }}
              onFocus={() => setPickerOpen(true)}
              onKeyDown={(e) => { if (e.key === 'Escape') setPickerOpen(false); }}
              style={{ width: '100%', paddingLeft: '2.4rem' }}
            />
            <Search size={16} style={{ position: 'absolute', left: '0.9rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
          {pickerOpen && (
            <div
              style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: '0.3rem', maxHeight: '320px', overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-glass-hover)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-glow)' }}
            >
              {myMatches.length > 0 && <div style={{ padding: '0.45rem 0.75rem 0.2rem', fontSize: '0.68rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t('sets.yourSets')}</div>}
              {myMatches.map(s => (
                <button key={`mine-${s.set_id}`} type="button" onClick={() => pick({ id: s.set_id, lang: s.lang })}
                  style={{ display: 'flex', width: '100%', gap: '0.5rem', alignItems: 'center', padding: '0.45rem 0.75rem', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '0.82rem' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.set_name || s.set_id}</span>
                  <code style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{String(s.set_id).replace(/^(mtg|lorcana|riftbound)-/, '').toUpperCase()}</code>
                  <span style={{ fontSize: '0.68rem', color: 'var(--type-grass)' }}>{t('sets.ownedCards', { count: s.owned })}</span>
                </button>
              ))}
              {allMatches.length > 0 && <div style={{ padding: '0.45rem 0.75rem 0.2rem', fontSize: '0.68rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t('sets.allSets')}</div>}
              {allMatches.map(s => (
                <button key={`all-${s.id}`} type="button" onClick={() => pick({ id: s.id })}
                  style={{ display: 'flex', width: '100%', gap: '0.5rem', alignItems: 'center', padding: '0.45rem 0.75rem', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '0.82rem' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  <code style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{String(s.id).replace(/^(mtg|lorcana|riftbound)-/, '').toUpperCase()}</code>
                  {s.release_date && <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{String(s.release_date).slice(0, 4)}</span>}
                </button>
              ))}
              {!myMatches.length && !allMatches.length && (
                <div style={{ padding: '0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{t('sets.noSetMatches')}</div>
              )}
              <button type="button" onClick={() => setPickerOpen(false)}
                style={{ width: '100%', padding: '0.4rem', background: 'var(--surface-1)', border: 'none', borderTop: '1px solid var(--border-glass)', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer' }}>
                {t('common.close')}
              </button>
            </div>
          )}
        </div>
        {game === 'pokemon' && (
          <div className="form-group" style={{ marginBottom: 0, flex: '0 0 auto' }}>
            <label htmlFor="set-completion-lang">{t('sets.language')}</label>
            <select id="set-completion-lang" className="select-control" value={lang} onChange={(e) => changeLang(e.target.value)}>
              {getLanguagesForGame('pokemon').map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {!target && !loading && (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '2.5rem 1.5rem', color: 'var(--text-secondary)' }}>
          <p style={{ margin: '0 auto 1rem', maxWidth: '440px' }}>{t('sets.landingHint')}</p>
          {mySets.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
              {mySets.slice(0, 12).map(s => (
                <button key={s.set_id} type="button" className="btn btn-secondary" onClick={() => pick({ id: s.set_id, lang: s.lang })}
                  style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem' }}>
                  {s.set_name || s.set_id} <span style={{ color: 'var(--text-muted)' }}>· {s.owned}</span>
                </button>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>{t('sets.noOwnedSets')}</p>
          )}
        </div>
      )}

      {loading && !data && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          <div className="spinner"></div>
          <p>{t('sets.loadingSet')}</p>
        </div>
      )}

      {error && !loading && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={() => load(target)} style={{ marginTop: '0.75rem' }}>{t('sets.retry')}</button>
        </div>
      )}

      {data && summary && (
        <>
          <div className="glass-panel" style={{ marginBottom: '1.25rem', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap' }}>
              {art && (
                <img src={art} alt="" loading="lazy" style={{ height: '40px', maxWidth: '120px', objectFit: 'contain' }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-strong)' }}>{data.set.name}</h2>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {setCodeShown}{data.set.release_date ? ` · ${String(data.set.release_date).replace(/\//g, '-')}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => load(target, { refresh: true })} disabled={loading}
                title={t('sets.refresh')} aria-label={t('sets.refresh')} style={{ width: '34px', height: '34px' }}>
                <RefreshCw size={15} />
              </button>
            </div>

            <div>
              <div className="set-progress-header">
                <span style={{ color: 'var(--text-strong)' }}>
                  {t(variantView ? 'sets.progressPrintings' : 'sets.progressCards', { owned: summary.owned, total: summary.total })}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{summary.percent}%</span>
              </div>
              <div className="set-progress-bar-bg" style={{ height: '10px' }}>
                <div className="set-progress-bar-fill" style={{ width: `${summary.percent}%` }}></div>
              </div>
              {/* The dashboard measures against the number printed on the cards
                  (198 for Scarlet & Violet); this view lists every card, so say
                  where the difference comes from. */}
              {data.set.printed_total > 0 && data.cards.length > data.set.printed_total && (
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                  {t('sets.beyondPrinted', { extra: data.cards.length - data.set.printed_total, printed: data.set.printed_total })}
                </div>
              )}
            </div>

            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t('sets.missingValue')}: </span>
              {summary.missing === 0 ? t('sets.complete') : parts.length ? (
                <>
                  <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                    {(summary.unpriced_missing ? t('sets.atLeast', { value: parts.map(([cur, v]) => priceText(v, cur)).join(' + ') }) : parts.map(([cur, v]) => priceText(v, cur)).join(' + '))}
                  </span>
                  {summary.unpriced_missing > 0 && <span> · {t('sets.unpriced', { count: summary.unpriced_missing })}</span>}
                </>
              ) : t('sets.valueUnknown')}
            </div>

            {data.stale && <div style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{t('sets.stale')}</div>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
              <div className="sub-nav-tabs" style={{ margin: 0 }}>
                {[['all', 'sets.showAll'], ['owned', 'sets.showOwned'], ['missing', 'sets.showMissing']].map(([key, label]) => (
                  <button key={key} type="button" className={`sub-nav-tab ${show === key ? 'active' : ''}`}
                    style={{ padding: '0.35rem 0.85rem', fontSize: '0.75rem' }} onClick={() => setShow(key)}>
                    {t(label)}
                  </button>
                ))}
              </div>
              {data.game === 'pokemon' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: data.summary.variants ? 'var(--text-primary)' : 'var(--text-muted)', cursor: data.summary.variants ? 'pointer' : 'not-allowed' }}
                  title={data.summary.variants ? t('sets.variantsHint') : t('sets.variantsUnavailable')}>
                  <input type="checkbox" checked={variantView} disabled={!data.summary.variants} onChange={(e) => setVariants(e.target.checked)}
                    style={{ accentColor: 'var(--type-grass)' }} />
                  {t('sets.variants')}
                </label>
              )}
              <button type="button" className="btn btn-primary" onClick={buyMissing} disabled={summary.missing === 0}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}>
                <ShoppingCart size={14} />
                {t('sets.buyMissing')}
              </button>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 1rem' }}>{t('sets.noCardsShown')}</div>
          ) : (
            <div className="card-grid">
              {shown.map(card => {
                const done = isComplete(card, variantView);
                const have = card.owned > 0;
                return (
                  <div key={card.id} className="tcg-card" onClick={() => setZoom(card)} title={`${displayName(card)} #${card.number}`}>
                    <div className="tcg-card-inner" style={done ? undefined : { borderStyle: 'dashed' }}>
                      <CardImage card={card} game={data.game} className="tcg-card-image" loading="lazy" draggable={false}
                        style={have ? undefined : { filter: 'grayscale(1)', opacity: 0.4 }} />
                      {have && <div className="tcg-card-quantity-tag">x{card.owned}</div>}
                      {!have && card.wishlisted && (
                        <span title={t('sets.wishlisted')} aria-label={t('sets.wishlisted')}
                          style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 10, display: 'flex', padding: '3px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: 'var(--accent-red)' }}>
                          <Heart size={12} fill="currentColor" />
                        </span>
                      )}
                    </div>
                    <div className="tcg-card-info">
                      <div className="tcg-card-name" style={have ? undefined : { color: 'var(--text-secondary)' }}>{displayName(card)}</div>
                      <div className="tcg-card-meta">
                        <span>#{card.number}</span>
                        {!done && card.price != null && <span className="tcg-card-price">{priceText(card.price, card.price_currency)}</span>}
                      </div>
                      {variantView && card.variants.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '0.2rem' }}>
                          {card.variants.map(v => (
                            <span key={v.printing} title={`${v.printing}${v.owned ? ` × ${v.owned}` : ''}`}
                              style={{
                                fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px',
                                ...(v.owned > 0
                                  ? getPrintingBadgeStyle(v.printing)
                                  : { background: 'transparent', color: 'var(--text-muted)', border: '1px dashed var(--border-glass-hover)' }),
                              }}>
                              {getPrintingBadgeLabel(v.printing) || t('sets.normalBadge')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {zoom && <CardImageZoom card={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
