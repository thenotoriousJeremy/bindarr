// Which 401s mean "you are signed out".
//
// The fetch wrapper in App.jsx used to sign the user out on ANY 401, so a route
// that answered 401 for some other reason -- a mistyped current password in
// Settings was the one people hit -- dropped the whole session, and the toast
// explaining why was never seen. Only the auth gate itself
// (backend/src/middleware/auth.js) can say the session is gone, and it marks that
// answer with this code. Everything else is an answer for the screen that asked.
export const SESSION_EXPIRED = 'session_expired';

// What that same gate said before it carried the code. The Android/iOS app can be
// newer than the server it talks to, and it still has to notice when an older
// server says the session has ended. Only ever sent from the gate, so matching the
// exact text cannot catch any other route's 401.
const LEGACY_GATE_ERRORS = new Set([
  'Access denied. No token provided.',
  'Invalid or expired session token.',
]);

// Reads a CLONE, so the caller still gets the body. Anything unreadable -- an HTML
// page from a proxy, an empty body -- is not our session ending.
export async function isSessionExpired(response) {
  if (!response || response.status !== 401) return false;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return false;
  }
  if (!body || typeof body !== 'object') return false;
  if (body.code !== undefined) return body.code === SESSION_EXPIRED;
  return LEGACY_GATE_ERRORS.has(body.error);
}
