// The server answers a failed SSO sign-in with one of these codes in ?oidc_error=
// (routes/auth.js oidcReturn), never with text: a link can put anything in a URL,
// and the login screen would have shown it as the server's own words. Anything
// else gets the generic message. Shared by the web return (Login.jsx) and the
// app's bindarr://oidc return (App.jsx), so both say the same thing.
export const OIDC_ERRORS = {
  access_denied: 'login.oidcAccessDenied',
  idp_error: 'login.oidcIdpError',
  missing_code: 'login.oidcRestart',
  state_invalid: 'login.oidcRestart',
  nonce_mismatch: 'login.oidcRestart',
  id_token_expired: 'login.oidcRestart',
  browser_mismatch: 'login.oidcBrowserMismatch',
  username_taken: 'login.oidcUsernameTaken',
  identity_conflict: 'login.oidcIdentityConflict',
  no_account: 'login.oidcNoAccount',
  setup_code_required: 'login.oidcSetupCodeRequired',
  setup_code_invalid: 'login.setupCodeInvalid',
};

export const oidcErrorKey = (code) =>
  (Object.prototype.hasOwnProperty.call(OIDC_ERRORS, code) ? OIDC_ERRORS[code] : 'login.errOidcFailed');
