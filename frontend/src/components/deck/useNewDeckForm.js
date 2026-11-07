import { useState } from 'react';
import { defaultGame } from '../../utils/games';
import { newDeckDefaults } from './deckHelpers';

// The new-deck form's state. DeckBuilder holds it (rather than the create dialog)
// so a half-filled form survives closing and reopening the dialog.
export function useNewDeckForm() {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');
  const [newDeckGame, setNewDeckGame] = useState(() => defaultGame()); // 'pokemon' | 'mtg'
  const [newDeckFormat, setNewDeckFormat] = useState(() => newDeckDefaults(defaultGame()).format);
  const [newDeckCategory, setNewDeckCategory] = useState('Competitive');
  const [newDeckAccentColor, setNewDeckAccentColor] = useState('#eab308');
  const [newDeckTargetSize, setNewDeckTargetSize] = useState(() => newDeckDefaults(defaultGame()).targetSize);
  const [newDeckAnyPrinting, setNewDeckAnyPrinting] = useState(() => newDeckDefaults(defaultGame()).anyPrinting);
  const [newDeckImportText, setNewDeckImportText] = useState('');
  const [newDeckImportFormat, setNewDeckImportFormat] = useState('plain');
  const [showImportDecklistArea, setShowImportDecklistArea] = useState(false);

  // A new deck's format, size and any-printing setting all follow the game picked.
  const pickNewDeckGame = (game) => {
    const defaults = newDeckDefaults(game);
    setNewDeckGame(game);
    setNewDeckFormat(defaults.format);
    setNewDeckTargetSize(defaults.targetSize);
    setNewDeckAnyPrinting(defaults.anyPrinting);
  };

  return {
    showCreateModal, setShowCreateModal,
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
  };
}
