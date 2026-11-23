// The card-list import Settings and Add Cards share: one file, read as text and
// sent to POST /api/import, which merges it into the collection.
//
// The file's extension picks the format: .txt is a decklist with printings
// ("1 Sol Ring (C21) 263", what ManaBox, Moxfield and Arena export), .json is
// Bindarr's own collection export, anything else is CSV (Bindarr's, or a
// TCGplayer, Deckbox, Dragon Shield... export; a spreadsheet saved as CSV).
import { sendJson, ApiError } from './request.js';
import { apiErrorText } from './apiError.js';

export function importFormatFor(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.txt')) return 'manabox';
  return 'csv';
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}

// Asks first (the merge cannot be undone), then imports and reports the outcome
// through the toast. Resolves true when cards were imported.
export async function importCardFile({ fileName, format, data, t, showToast }) {
  if (!window.confirm(t('settings.confirmImport', { file: fileName }))) return false;
  showToast(t('settings.importing'));
  try {
    const { data: result } = await sendJson('/api/import', 'POST', { format, data });
    showToast((result && result.message) || t('settings.importOk'));
    return true;
  } catch (err) {
    console.error(err);
    const error = err instanceof ApiError
      ? apiErrorText(t, err.body || {}, 'settings.unknownError')
      : err.message;
    showToast(t('settings.importFailed', { error }));
    return false;
  }
}
