// SSO in the browser: the server's callback sends the page back to /?oidc_code=...
//
// That is a one-time code, never the session itself, and it redeems only together
// with the HttpOnly cookie this browser was given when it started the login (see
// issueWebCode in backend/src/utils/oidc.js). So a link carrying someone else's
// code signs nobody in: the cookie that would match it is in their browser.
//
// The plain ?token= / ?oidc_token= sign-in this replaced took a session token
// from any link and signed the visitor into whichever account it named.

// { code, cleanUrl } when `href` is an SSO return, else null. cleanUrl is the
// same address without the code, for history.replaceState: taken off before the
// code is used, so a reload, a bookmark or the history cannot present it again.
export function readOidcCode(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const code = url.searchParams.get('oidc_code');
  if (!code) return null;
  url.searchParams.delete('oidc_code');
  return { code, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}
