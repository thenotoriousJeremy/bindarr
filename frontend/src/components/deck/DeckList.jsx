import { Plus, Trash2, X, Search, LogOut, PackageCheck, LayoutGrid, List, Filter, Layers, Zap, Swords, Gamepad2, SlidersHorizontal, ArrowRight } from 'lucide-react';
import { onActivateKey } from '../../utils/a11y';
import { gameOptions, showGamePicker, LEGACY_GAME } from '../../utils/games';
import { useT } from '../../utils/i18n';

// The deck overview: every deck, filtered, sorted and shown as cards or a table.
// The filter state lives in DeckBuilder so it survives opening a deck and coming
// back; opening, checkout/return and delete are DeckBuilder's handlers too.
export default function DeckList({
  decks, loading, checkingOut,
  deckSearchTerm, setDeckSearchTerm, deckGameFilter, setDeckGameFilter,
  deckStatusFilter, setDeckStatusFilter, deckSortBy, setDeckSortBy,
  deckSelectionViewMode, setDeckSelectionViewMode,
  setShowCreateModal, openDeck, handleCheckout, handleReturn, handleDeleteDeck,
}) {
  const { t } = useT();

  // --- SELECTION MENU METRICS & FILTERING ---
  const totalDecksCount = decks.length;
  const decksOfGame = (game) => decks.filter(d => (d.game || LEGACY_GAME) === game).length;

  const filteredDecks = decks.filter(deck => {
    const q = deckSearchTerm.trim().toLowerCase();
    const matchesSearch = !q ||
      deck.name.toLowerCase().includes(q) ||
      (deck.description && deck.description.toLowerCase().includes(q));

    const deckGameVal = deck.game || 'pokemon';
    const matchesGame = deckGameFilter === 'all' || deckGameVal === deckGameFilter;

    let matchesStatus = true;
    if (deckStatusFilter === 'ready') matchesStatus = deck.total_cards === (deck.target_size || 60);
    else if (deckStatusFilter === 'in_progress') matchesStatus = (deck.total_cards || 0) < (deck.target_size || 60);
    else if (deckStatusFilter === 'in_play') matchesStatus = !!deck.checked_out;

    return matchesSearch && matchesGame && matchesStatus;
  }).sort((a, b) => {
    if (deckSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (deckSortBy === 'cards_desc') return (b.total_cards || 0) - (a.total_cards || 0);
    if (deckSortBy === 'created_asc') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      
      {/* Top Banner Header & Primary Action */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem 1.5rem', background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', color: 'var(--text-strong)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <Layers size={22} style={{ color: 'var(--accent-yellow)' }} />
            {t('deck.vaultTitle')}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {t('deck.vaultSubtitle')}
          </p>
        </div>
        <button 
          className="btn btn-primary" 
          onClick={() => setShowCreateModal(true)}
          style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', boxShadow: '0 4px 14px rgba(234, 179, 8, 0.25)' }}
        >
          <Plus size={18} /> {t('deck.createDeck')}
        </button>
      </div>

      {/* Search, Filters, Sorting & View Toolbar */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          
          {/* Search input */}
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
            <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="input-control"
              placeholder={t('deck.filterPlaceholder')}
              value={deckSearchTerm}
              onChange={e => setDeckSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }}
            />
            {deckSearchTerm && (
              <button
                className="btn btn-secondary btn-icon-only"
                onClick={() => setDeckSearchTerm('')}
                style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '20px', padding: 0, fontSize: '0.7rem' }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Game Tabs — only the games Settings is showing. */}
          {showGamePicker() && (
          <div className="sub-nav-tabs" style={{ margin: 0, background: 'rgba(0,0,0,0.25)', padding: '3px', borderRadius: 'var(--radius-sm)' }}>
            {[
              ['all', 'All Decks', totalDecksCount],
              ...gameOptions().map(g => [g.value, g.short, decksOfGame(g.value)]),
            ].map(([val, label, count]) => (
              <button
                key={val}
                type="button"
                className={`sub-nav-tab ${deckGameFilter === val ? 'active' : ''}`}
                onClick={() => setDeckGameFilter(val)}
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <span>{label}</span>
                <span style={{ fontSize: '0.65rem', background: deckGameFilter === val ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '10px' }}>
                  {count}
                </span>
              </button>
            ))}
          </div>
          )}

        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-glass)' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {/* Status Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Filter size={14} style={{ color: 'var(--text-muted)' }} />
              <select
                className="select-control"
                value={deckStatusFilter}
                onChange={e => setDeckStatusFilter(e.target.value)}
                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
              >
                <option value="all">{t('deck.allStatuses')}</option>
                <option value="ready">{t('deck.statusBattleReady')}</option>
                <option value="in_progress">{t('deck.statusBuildingCount')}</option>
                <option value="in_play">{t('deck.statusInPlayEmoji')}</option>
              </select>
            </div>

            {/* Sort Order */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
              <select
                className="select-control"
                value={deckSortBy}
                onChange={e => setDeckSortBy(e.target.value)}
                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
              >
                <option value="created_desc">{t('deck.sortNewest')}</option>
                <option value="created_asc">{t('deck.sortOldest')}</option>
                <option value="name_asc">{t('collection.sort.name-asc')}</option>
                <option value="cards_desc">{t('deck.sortMostCards')}</option>
              </select>
            </div>
          </div>

          {/* View Mode Toggle: Grid vs Table */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'rgba(0,0,0,0.3)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              type="button"
              className={`btn ${deckSelectionViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
              onClick={() => setDeckSelectionViewMode('grid')}
              title={t('deck.gridView')}
            >
              <LayoutGrid size={13} /> Grid
            </button>
            <button
              type="button"
              className={`btn ${deckSelectionViewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
              onClick={() => setDeckSelectionViewMode('table')}
              title={t('deck.tableView')}
            >
              <List size={13} /> Table
            </button>
          </div>

        </div>
      </div>

      {/* Decks Display Section */}
      {loading ? (
        <div className="spinner" style={{ margin: '3rem auto' }}></div>
      ) : filteredDecks.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 1.5rem', color: 'var(--text-secondary)' }}>
          <Layers size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.05rem', marginBottom: '0.25rem' }}>{t('deck.noMatches')}</h3>
          <p style={{ fontSize: '0.85rem' }}>{t('deck.noMatchesHint')}</p>
          {(deckSearchTerm || deckGameFilter !== 'all' || deckStatusFilter !== 'all') && (
            <button
              className="btn btn-secondary"
              style={{ marginTop: '1rem', fontSize: '0.8rem' }}
              onClick={() => { setDeckSearchTerm(''); setDeckGameFilter('all'); setDeckStatusFilter('all'); }}
            >
              {t('deck.clearFilters')}
            </button>
          )}
        </div>
      ) : deckSelectionViewMode === 'grid' ? (
        /* --- GRID VIEW --- */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
          {filteredDecks.map(deck => {
            const deckGameVal = deck.game || 'pokemon';
            const isMtg = deckGameVal === 'mtg';
            const targetSize = deck.target_size || 60;
            const totalCards = deck.total_cards || 0;
            const isComplete = totalCards >= targetSize;
            const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
            const accentColor = deck.accent_color || (isMtg ? '#ef4444' : '#eab308');

            return (
              <div
                key={deck.id}
                className="glass-panel"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '1.25rem',
                  border: deck.checked_out
                    ? '1px solid rgba(234,179,8,0.5)'
                    : `1px solid ${accentColor}40`,
                  position: 'relative',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  background: isMtg
                    ? 'linear-gradient(145deg, rgba(211,32,42,0.06), rgba(15,23,42,0.65))'
                    : 'linear-gradient(145deg, rgba(234,179,8,0.06), rgba(15,23,42,0.65))'
                }}
                role="button"
                tabIndex={0}
                onClick={() => openDeck(deck.id)}
                onKeyDown={onActivateKey(() => openDeck(deck.id))}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'translateY(-3px)';
                  e.currentTarget.style.boxShadow = `0 12px 30px ${accentColor}25`;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {/* Top Accent Line */}
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
                  background: deck.checked_out
                    ? 'linear-gradient(90deg, #eab308, #f59e0b)'
                    : `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`
                }} />

                {/* In Play Banner */}
                {deck.checked_out ? (
                  <div style={{
                    marginTop: '4px',
                    background: 'linear-gradient(90deg, rgba(234,179,8,0.9), rgba(245,158,11,0.85))',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    color: '#000',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase'
                  }}>
                    <Gamepad2 size={12} />
                    <span>{t('deck.inPlay')}</span>
                    {deck.checked_out_at && (
                      <span style={{ marginLeft: 'auto', opacity: 0.8, fontWeight: 600 }}>
                        since {new Date(deck.checked_out_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ) : null}

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <h3 style={{ color: 'var(--text-strong)', fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
                          {deck.name}
                        </h3>
                        <span style={{
                          fontSize: '0.6rem',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          padding: '0.1rem 0.45rem',
                          borderRadius: '4px',
                          background: isMtg ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
                          color: isMtg ? '#f87171' : 'var(--accent-yellow)',
                          border: isMtg ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(234,179,8,0.3)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px'
                        }}>
                          {isMtg ? <Swords size={10} /> : <Zap size={10} />}
                          {isMtg ? 'MTG' : 'Pokémon'}
                        </span>

                        {deck.format && (
                          <span style={{
                            fontSize: '0.6rem',
                            fontWeight: 700,
                            padding: '0.1rem 0.4rem',
                            borderRadius: '4px',
                            background: 'rgba(255,255,255,0.06)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-glass)'
                          }}>
                            {deck.format}
                          </span>
                        )}

                        {deck.category && (
                          <span style={{
                            fontSize: '0.6rem',
                            fontWeight: 700,
                            padding: '0.1rem 0.4rem',
                            borderRadius: '4px',
                            background: 'rgba(59, 130, 246, 0.12)',
                            color: '#60a5fa',
                            border: '1px solid rgba(59, 130, 246, 0.25)'
                          }}>
                            {deck.category}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Status Badge */}
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      padding: '0.2rem 0.5rem',
                      borderRadius: '12px',
                      backgroundColor: isComplete ? 'rgba(74, 222, 128, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                      color: isComplete ? '#4ade80' : '#60a5fa',
                      border: isComplete ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)',
                      whiteSpace: 'nowrap'
                    }}>
                      {t(isComplete ? 'deck.statusReady' : 'deck.statusBuilding')}
                    </span>
                  </div>

                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.6rem', minHeight: '34px', lineHeight: '1.4' }}>
                    {deck.description || 'No description provided.'}
                  </p>
                </div>

                {/* Progress Bar & Details */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.cardCapacity')}</span>
                    <span style={{ color: isComplete ? '#4ade80' : 'var(--text-strong)', fontWeight: 700 }}>
                      {totalCards} / {targetSize} Cards ({percent}%)
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${percent}%`,
                      background: isComplete
                        ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                        : 'linear-gradient(90deg, #3b82f6, #6366f1)',
                      borderRadius: '3px',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Created {new Date(deck.created_at).toLocaleDateString()}
                  </span>

                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    {deck.checked_out ? (
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                        onClick={(e) => { e.stopPropagation(); handleReturn(deck); }}
                        disabled={checkingOut}
                      >
                        <PackageCheck size={12} /> Return
                      </button>
                    ) : (
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={(e) => { e.stopPropagation(); handleCheckout(deck); }}
                        disabled={checkingOut}
                      >
                        <LogOut size={12} /> Checkout
                      </button>
                    )}

                    <button
                      className="btn btn-primary"
                      style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                      onClick={(e) => { e.stopPropagation(); openDeck(deck.id); }}
                    >
                      Open <ArrowRight size={12} />
                    </button>

                    <button
                      className="btn btn-danger btn-icon-only"
                      style={{ padding: '0.3rem' }}
                      onClick={(e) => { e.stopPropagation(); handleDeleteDeck(deck.id, deck.name); }}
                      title={t('deck.deleteDeck')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      ) : (
        /* --- TABLE VIEW --- */
        <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
          <table className="collection-table deck-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colGameFormat')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colNameDesc')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colCapacity')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colStatus')}</th>
                <th className="hide-mobile" style={{ padding: '0.75rem 1rem' }}>{t('admin.colCreated')}</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>{t('admin.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredDecks.map(deck => {
                const isMtg = (deck.game || 'pokemon') === 'mtg';
                const targetSize = deck.target_size || 60;
                const totalCards = deck.total_cards || 0;
                const isComplete = totalCards >= targetSize;
                const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                const accentColor = deck.accent_color || (isMtg ? '#ef4444' : '#eab308');

                return (
                  <tr
                    key={deck.id}
                    style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.15s' }}
                    onClick={() => openDeck(deck.id)}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: accentColor, display: 'inline-block' }} />
                          <span style={{
                            fontSize: '0.65rem',
                            fontWeight: 800,
                            padding: '0.15rem 0.45rem',
                            borderRadius: '4px',
                            background: isMtg ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
                            color: isMtg ? '#f87171' : 'var(--accent-yellow)',
                            border: isMtg ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(234,179,8,0.3)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px'
                          }}>
                            {isMtg ? <Swords size={10} /> : <Zap size={10} />}
                            {isMtg ? 'MTG' : 'Pokémon'}
                          </span>
                        </div>
                        {deck.format && (
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                            {deck.format}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{deck.name}</span>
                        {deck.category && (
                          <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}>
                            {deck.category}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        {deck.description || 'No description'}
                      </div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', width: '160px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isComplete ? '#4ade80' : 'var(--text-strong)' }}>
                          {totalCards} / {targetSize} Cards
                        </div>
                        <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${percent}%`, background: isComplete ? '#4ade80' : '#3b82f6' }} />
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {deck.checked_out ? (
                        <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.4)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <Gamepad2 size={11} /> In Play
                        </span>
                      ) : isComplete ? (
                        <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                          {t('deck.statusReady')}
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                          {t('deck.statusBuilding')}
                        </span>
                      )}
                    </td>
                    <td className="hide-mobile" style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {new Date(deck.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                      <div role="presentation" style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                        {deck.checked_out ? (
                          <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: '#eab308' }} onClick={() => handleReturn(deck)} disabled={checkingOut}>
                            {t('deck.return')}
                          </button>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleCheckout(deck)} disabled={checkingOut}>
                            {t('deck.checkout')}
                          </button>
                        )}
                        <button className="btn btn-primary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => openDeck(deck.id)}>
                          {t('deck.open')}
                        </button>
                        <button className="btn btn-danger btn-icon-only" style={{ padding: '0.25rem' }} onClick={() => handleDeleteDeck(deck.id, deck.name)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
