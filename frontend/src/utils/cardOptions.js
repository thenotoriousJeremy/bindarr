// Shared <select> option lists for collection entry fields, previously
// copy-pasted across LocationManager, CollectionList, CardSearch, and
// CameraScanner's quick-add/edit forms.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
export const LANGUAGES = ['English', 'Japanese', 'German', 'French', 'Spanish', 'Italian'];

// A binder-family container lays out fixed pockets (Pages); other container
// types (boxes, deck boxes) are continuous (Rows). Kept here so the several
// UI spots that branch on it share one definition.
export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';
