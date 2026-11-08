import { X, Upload, Zap, Swords, Gamepad2, FolderPlus, FileText, Layers } from 'lucide-react';
import Modal from '../Modal';
import { defaultGame, gameOptions, showGamePicker } from '../../utils/games';
import { formatNames, defaultTargetSize, supportsAnyPrinting } from '../../utils/deckRules';
import { useT } from '../../utils/i18n';
import AnyPrintingField from './AnyPrintingField';
import { DECK_CATEGORIES, DECK_ACCENT_COLORS } from './deckHelpers';

// How each game's button looks in the new-deck picker. Presentation only: which
// games exist, and what a deck starts as, come from the registry. A game with no
// entry still gets a button, just a plain one.
const GAME_PICKER_LOOK = {
  pokemon: { Icon: Zap, color: 'var(--accent-yellow)', tint: 'rgba(234, 179, 8, 0.12)', titleKey: 'deck.gamePokemonWithSystem', subKey: 'deck.standard60' },
  mtg: { Icon: Swords, color: '#ef4444', tint: 'rgba(239, 68, 68, 0.12)', titleKey: 'deck.gameMtgWithSystem', subKey: 'deck.constructedCommander' },
  lorcana: { Icon: Layers, color: '#a855f7', tint: 'rgba(168, 85, 247, 0.12)', titleKey: 'deck.gameLorcanaWithSystem', subKey: 'deck.standard60' },
  riftbound: { Icon: Swords, color: '#38bdf8', tint: 'rgba(56, 189, 248, 0.12)', subKey: 'deck.riftboundConstructed' },
};
const PLAIN_PICKER_LOOK = { Icon: Gamepad2, color: 'var(--text-strong)', tint: 'rgba(255, 255, 255, 0.08)' };

// The create-deck dialog, with its optional quick decklist import. The form state
// is DeckBuilder's (useNewDeckForm), passed in as `form`.
export default function DeckCreateDialog({ form, showToast, fetchDecks }) {
  const { t } = useT();
  const {
    setShowCreateModal,
    newDeckName, setNewDeckName,
    newDeckDesc, setNewDeckDesc,
    newDeckGame,
    newDeckFormat, setNewDeckFormat,
    newDeckCategory, setNewDeckCategory,
    newDeckAccentColor, setNewDeckAccentColor,
    newDeckTargetSize, setNewDeckTargetSize,
    newDeckAnyPrinting, setNewDeckAnyPrinting,
    newDeckImportText, setNewDeckImportText,
    newDeckImportFormat, setNewDeckImportFormat,
    showImportDecklistArea, setShowImportDecklistArea,
    pickNewDeckGame,
  } = form;

  const handleCreateDeck = async (e) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;

    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newDeckName, 
          description: newDeckDesc, 
          game: newDeckGame,
          format: newDeckFormat,
          category: newDeckCategory,
          accent_color: newDeckAccentColor,
          target_size: newDeckTargetSize,
          any_printing: newDeckAnyPrinting,
          decklist_text: newDeckImportText,
          decklist_format: newDeckImportFormat
        })
      });

      if (response.ok) {
        showToast(t('deck.created'));
        setNewDeckName('');
        setNewDeckDesc('');
        pickNewDeckGame(defaultGame());
        setNewDeckCategory('Competitive');
        setNewDeckAccentColor('#eab308');
        setNewDeckImportText('');
        setNewDeckImportFormat('plain');
        setShowImportDecklistArea(false);
        setShowCreateModal(false);
        fetchDecks();
      } else {
        showToast(t('deck.errCreate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCreateGeneric'));
    }
  };

  const handleManaBoxDeckFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setNewDeckImportText(String(reader.result || ''));
      setNewDeckImportFormat('manabox');
      if (!newDeckName.trim()) setNewDeckName(file.name.replace(/\.txt$/i, ''));
    };
    reader.onerror = () => showToast(t('settings.errReadFile'));
    reader.readAsText(file);
    event.target.value = '';
  };

  return (
    <Modal onClose={() => setShowCreateModal(false)} label={t('deck.createTitle')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
      className="glass-panel" style={{ maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
        <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreateModal(false)} aria-label={t('common.close')} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
          <X size={16} />
        </button>

        <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', fontWeight: 800, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FolderPlus size={20} style={{ color: 'var(--accent-yellow)' }} />
          {t('deck.createTitle')}
        </h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          {t('deck.createSubtitle')}
        </p>

        <form onSubmit={handleCreateDeck} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '80vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
          
          {/* Game System Selection — hidden when only one game is shown, in
              which case newDeckGame already holds it. */}
          {showGamePicker() && (
          <div className="form-group">
            <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.gameSystem')}</label>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gameOptions().length}, 1fr)`, gap: '0.75rem' }}>
              {gameOptions().map(({ value, label }) => {
                const look = GAME_PICKER_LOOK[value] || PLAIN_PICKER_LOOK;
                const on = newDeckGame === value;
                const { Icon } = look;
                return (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={on}
                    onClick={() => pickNewDeckGame(value)}
                    style={{
                      color: 'inherit',
                      font: 'inherit',
                      padding: '0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      border: on ? `2px solid ${look.color}` : '1px solid var(--border-glass)',
                      background: on ? look.tint : 'rgba(0, 0, 0, 0.2)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.3rem',
                      transition: 'all 0.15s'
                    }}
                  >
                    <Icon size={22} style={{ color: on ? look.color : 'var(--text-muted)' }} />
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: on ? look.color : 'var(--text-secondary)' }}>{look.titleKey ? t(look.titleKey) : label}</span>
                    {look.subKey && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t(look.subKey)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Format & Target Size Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
            <div className="form-group">
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.format')}</label>
              <select
                className="input-control"
                value={newDeckFormat}
                onChange={(e) => {
                  const selectedFmt = e.target.value;
                  setNewDeckFormat(selectedFmt);
                  setNewDeckTargetSize(defaultTargetSize(newDeckGame, selectedFmt));
                }}
                style={{ fontSize: '0.85rem' }}
              >
                {formatNames(newDeckGame).map(fmt => (
                  <option key={fmt} value={fmt} style={{ background: '#1e293b', color: '#fff' }}>{fmt}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.targetSize')}</label>
              <input
                type="number"
                min="1"
                max="300"
                className="input-control"
                value={newDeckTargetSize}
                onChange={(e) => setNewDeckTargetSize(parseInt(e.target.value, 10) || 60)}
                style={{ fontSize: '0.85rem' }}
              />
            </div>
          </div>

          {supportsAnyPrinting(newDeckGame) && (
            <AnyPrintingField t={t} checked={newDeckAnyPrinting} onChange={setNewDeckAnyPrinting} />
          )}

          {/* Deck Name */}
          <div className="form-group">
            <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.deckName')}</label>
            <input 
              type="text" 
              className="input-control" 
              placeholder={t('deck.namePlaceholder')} 
              value={newDeckName} 
              onChange={(e) => setNewDeckName(e.target.value)}
              required 
              autoFocus
            />
          </div>

          {/* Category Pills */}
          <div className="form-group">
            <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.category')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {DECK_CATEGORIES.map(cat => {
                const isSelected = newDeckCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setNewDeckCategory(cat)}
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '0.3rem 0.65rem',
                      borderRadius: '12px',
                      border: isSelected ? '1px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                      background: isSelected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(0,0,0,0.2)',
                      color: isSelected ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    }}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Deck Accent Color */}
          <div className="form-group">
            <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.accentColor')}</label>
            <div style={{ display: 'flex', itemsAlign: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {DECK_ACCENT_COLORS.map(c => {
                const isSelected = newDeckAccentColor === c.hex;
                return (
                  <button
                    type="button"
                    key={c.hex}
                    onClick={() => setNewDeckAccentColor(c.hex)}
                    title={c.name}
                    aria-label={c.name}
                    aria-pressed={isSelected}
                    style={{
                      padding: 0,
                      width: '26px',
                      height: '26px',
                      borderRadius: '50%',
                      backgroundColor: c.hex,
                      cursor: 'pointer',
                      border: isSelected ? '2px solid #ffffff' : '2px solid transparent',
                      boxShadow: isSelected ? `0 0 10px ${c.hex}` : 'none',
                      transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                      transition: 'all 0.15s'
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Description (Optional) */}
          <div className="form-group">
            <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.descriptionOptional')}</label>
            <textarea
              className="input-control"
              style={{ minHeight: '65px', resize: 'vertical', fontSize: '0.85rem' }}
              placeholder={t('deck.notesPlaceholder')}
              value={newDeckDesc}
              onChange={(e) => setNewDeckDesc(e.target.value)}
            />
          </div>

          {/* Quick Decklist Importer Toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowImportDecklistArea(!showImportDecklistArea)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-yellow)',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: 0
              }}
            >
              <FileText size={14} />
              {showImportDecklistArea ? t('deck.hideQuickImport') : t('deck.showQuickImport')}
            </button>

            {showImportDecklistArea && (
              <div style={{ marginTop: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <select
                    className="select-control"
                    value={newDeckImportFormat}
                    onChange={(e) => {
                      const format = e.target.value;
                      setNewDeckImportFormat(format);
                      if (format === 'manabox') pickNewDeckGame('mtg');
                    }}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
                  >
                    <option value="plain">{t('deck.importFormatPlain')}</option>
                    <option value="manabox">{t('deck.importFormatManaBox')}</option>
                  </select>
                  {newDeckImportFormat === 'manabox' && (
                    <label className="btn btn-secondary" style={{ margin: 0, padding: '0.3rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                      <Upload size={13} /> {t('deck.chooseManaBoxFile')}
                      <input type="file" accept=".txt,text/plain" onChange={handleManaBoxDeckFile} style={{ display: 'none' }} />
                    </label>
                  )}
                </div>
                <textarea
                  className="input-control"
                  style={{ minHeight: '90px', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre' }}
                  placeholder={t('deck.pasteDecklistPlaceholder')}
                  value={newDeckImportText}
                  onChange={(e) => setNewDeckImportText(e.target.value)}
                />
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem' }}>
                  {t('deck.importOnCreateHint')}
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 2, fontWeight: 700 }}>{t('deck.createDeck')}</button>
          </div>
        </form>
    </Modal>
  );
}
