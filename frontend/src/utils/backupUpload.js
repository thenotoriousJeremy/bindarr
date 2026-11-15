// What a full-backup restore uploads.
//
// Card data in a backup (card_cache, price history, TCGplayer product ids) is
// shared by every account on a server, so only an admin's restore takes it from
// the file; a member's restore looks each card up from its card database instead
// (backend/src/routes/backup.js). Those tables are most of a big backup's size,
// so a member's upload leaves them out, which keeps it under the member's
// smaller upload limit. An admin's, and the phone's own owner's, is sent whole.
export const SHARED_CARD_TABLES = new Set(['card_cache', 'price_history', 'tcgplayer_product']);

export function backupForUpload(backup, role) {
  if (role === 'admin' || !backup || typeof backup !== 'object' || !backup.data || typeof backup.data !== 'object') return backup;
  const data = Object.fromEntries(Object.entries(backup.data).filter(([table]) => !SHARED_CARD_TABLES.has(table)));
  return { ...backup, data };
}
