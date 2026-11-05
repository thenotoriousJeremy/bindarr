const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, authLimiter } = require('../middleware/auth');
const { verifyPassword, generateSession, revokeSessions } = require('../utils/authHelpers');
const oidc = require('../utils/oidc');
const { parseNavTabs, readNavTabs } = require('../utils/navTabs');

const router = express.Router();

// Open self-registration is off by default: this is an invite-only app where an
// administrator creates accounts (Admin panel) and hands out credentials. Set
// ALLOW_REGISTRATION=true to let anyone self-register a member account.
const REGISTRATION_ENABLED = process.env.ALLOW_REGISTRATION === 'true';

// Public config the login screen reads to decide whether to show the Sign Up
// option, whether OIDC / SSO is enabled, and whether this install still has no accounts.
// No auth — must be reachable before login.
router.get('/config', async (req, res) => {
  let setupRequired = false;
  try {
    const row = await db.get(`SELECT COUNT(*) as count FROM users`);
    setupRequired = row.count === 0;
  } catch (error) {
    console.error(error);
  }
  res.json({
    registrationEnabled: REGISTRATION_ENABLED,
    setupRequired,
    oidcEnabled: oidc.isOidcEnabled(),
    oidcProviderName: oidc.getProviderName()
  });
});

// The web login's browser-binding cookie. HttpOnly, so page script never sees it.
// SameSite=Lax, because the callback arrives as a top-level GET from the identity
// provider's site, which Lax still sends with. Scoped to the OIDC routes, and alive
// exactly as long as the state it pairs with. Secure whenever the request came in
// over https, a TLS-terminating proxy's X-Forwarded-Proto included.
function webBindingCookie(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || forwardedProto === 'https',
    path: oidc.WEB_BINDING_PATH,
    maxAge: oidc.STATE_TTL_MS
  };
}

// Initiate OIDC / SSO authorization code flow
router.get('/oidc/login', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) {
    return res.status(404).json({ error: 'OIDC authentication is not enabled.' });
  }

  // The Android/iOS app opens this in the system browser and says so with
  // client=native plus the challenge for its secret verifier (see
  // issueNativeCode). Only that literal value counts; anything else is a web login.
  let nativeChallenge;
  if (req.query.client === 'native') {
    if (!oidc.isValidNativeChallenge(req.query.challenge)) {
      return res.status(400).json({ error: 'A native app login requires a valid challenge.' });
    }
    nativeChallenge = req.query.challenge;
  }

  try {
    // A web login is tied to this browser by a cookie; the native app has its
    // verifier instead. See the web hand-off in utils/oidc.js.
    const webBinding = nativeChallenge ? null : oidc.createWebBinding();
    const authUrl = await oidc.buildAuthorizationUrl(req, {
      nativeChallenge,
      webBindingHash: webBinding ? webBinding.hash : undefined
    });
    if (webBinding) res.cookie(oidc.WEB_BINDING_COOKIE, webBinding.secret, webBindingCookie(req));
    res.redirect(302, authUrl);
  } catch (error) {
    const { message, log } = oidc.describeFetchError(error);
    console.error('OIDC login initiation failed:', log);
    res.status(500).json({ error: 'Failed to initiate OIDC login', message });
  }
});

// Handle OIDC / SSO callback from identity provider
router.get('/oidc/callback', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) {
    return res.status(404).json({ error: 'OIDC authentication is not enabled.' });
  }

  const { code, state, error, error_description } = req.query;

  // Where the result goes depends on who started the login, and only the signed
  // state can say that. It is read here, before anything can fail, so an IdP
  // error or a missing code still lands back in the app that is waiting for it.
  // No state, or one that does not verify: the web page, as it always was.
  const startedState = typeof state === 'string' ? oidc.verifyStateToken(state) : null;
  const native = !!(startedState && startedState.nat);

  const frontendRedirect = (params) => {
    const qs = new URLSearchParams(params).toString();
    if (native) {
      // Declared by the app's intent-filter (Android) / CFBundleURLTypes (iOS).
      return res.redirect(302, `bindarr://oidc?${qs}`);
    }
    const baseUrl = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
    res.redirect(302, `${baseUrl}/?${qs}`);
  };

  if (error) {
    console.error(`OIDC IdP error: ${error} - ${error_description || ''}`);
    return frontendRedirect({ oidc_error: error_description || error });
  }

  if (!code || !state) {
    return frontendRedirect({ oidc_error: 'Missing authorization code or state from identity provider.' });
  }

  // A web login has to finish in the browser that started it. Without this, a
  // callback link from someone else's login -- their IdP code, their state --
  // opened in your browser would sign you into THEIR account (login CSRF). Checked
  // before the IdP is called, so a refused link costs nothing. A state that does
  // not verify at all falls through to exchangeCode, which says so.
  if (startedState && !native
    && !oidc.matchesWebBinding(oidc.readCookie(req.headers.cookie, oidc.WEB_BINDING_COOKIE), startedState.wb)) {
    return frontendRedirect({
      oidc_error: 'This sign-in could not be completed in this browser. Please start it again from the login page.'
    });
  }

  try {
    const { extracted, state: stateData } = await oidc.exchangeCode({ code, stateToken: state, req });
    const { sub, username } = extracted;

    // 1. Match by existing oidc_sub
    let user = await db.get(`SELECT * FROM users WHERE oidc_sub = ?`, [sub]);

    // 2. Fallback: attach this identity to an existing account with the same
    //    username — only when the operator has said their IdP's usernames can be
    //    trusted for it. See isUsernameLinkEnabled: with it on by default, anyone
    //    who could set their own preferred_username to "admin" at the IdP could
    //    take the Bindarr owner account by signing in once.
    if (!user) {
      const existingUser = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
      // Linking off and the name is taken: say so, rather than falling through to
      // auto-provisioning, which would quietly hand them a brand new "<name>-1"
      // account with an empty collection and leave them convinced the upgrade ate
      // their cards.
      if (existingUser && !oidc.isUsernameLinkEnabled()) {
        console.warn(`OIDC: "${username}" already exists locally and OIDC_ALLOW_USERNAME_LINK is off — not linking.`);
        return frontendRedirect({
          oidc_error: 'A Bindarr account with this username already exists. An administrator must set OIDC_ALLOW_USERNAME_LINK=true to attach single sign-on to it.'
        });
      }
      if (existingUser) {
        // An account already bound to a DIFFERENT IdP identity is never re-bound.
        // Two subjects claiming one username is the collision this whole flag is
        // about, and silently moving the account to whoever logged in last is the
        // worst of the available answers.
        if (existingUser.oidc_sub && existingUser.oidc_sub !== sub) {
          console.warn(`OIDC: refusing to relink "${username}" — already bound to another identity.`);
          return frontendRedirect({
            oidc_error: 'That username is already linked to a different single sign-on identity. Ask an administrator.'
          });
        }
        await db.run(`UPDATE users SET oidc_sub = ? WHERE id = ?`, [sub, existingUser.id]);
        console.log(`OIDC: linked identity to existing account "${username}" (OIDC_ALLOW_USERNAME_LINK).`);
        user = await db.get(`SELECT * FROM users WHERE id = ?`, [existingUser.id]);
      }
    }

    // 3. User does not exist: first-run bootstrap or auto-provisioning
    if (!user) {
      const userCountRow = await db.get(`SELECT COUNT(*) as count FROM users`);
      const isFirstUser = userCountRow.count === 0;

      if (isFirstUser) {
        // Bootstrap instance owner via OIDC
        const shareToken = crypto.randomBytes(16).toString('hex');
        const lockedHash = `oidc_locked:${crypto.randomBytes(16).toString('hex')}`;
        const result = await db.run(`
          INSERT INTO users (username, password_hash, role, share_token, share_enabled, oidc_sub)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [OWNER_USERNAME, lockedHash, 'admin', shareToken, 0, sub]);

        await db.adoptOrphanRows(result.lastID);
        await db.seedStarterLocations(result.lastID);
        user = await db.get(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
      } else if (oidc.isAutoProvisionEnabled() || REGISTRATION_ENABLED) {
        // Auto-provision new member
        const shareToken = crypto.randomBytes(16).toString('hex');
        const lockedHash = `oidc_locked:${crypto.randomBytes(16).toString('hex')}`;
        const role = oidc.getDefaultRole();

        // Ensure clean, unique username in case of collisions
        let finalUsername = username;
        let suffix = 1;
        while (await db.get(`SELECT id FROM users WHERE username = ?`, [finalUsername])) {
          finalUsername = `${username}-${suffix++}`;
        }

        const result = await db.run(`
          INSERT INTO users (username, password_hash, role, share_token, share_enabled, oidc_sub)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [finalUsername, lockedHash, role, shareToken, 0, sub]);

        await db.seedStarterLocations(result.lastID);
        user = await db.get(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
      } else {
        return frontendRedirect({
          oidc_error: 'No matching Bindarr account found. Auto-provisioning is disabled; ask an administrator to create your account.'
        });
      }
    }

    if (stateData && stateData.nat) {
      // Never the session token through a custom scheme any app can claim: a
      // one-time code the app redeems at /oidc/exchange with its verifier.
      const appCode = oidc.issueNativeCode(user.id, stateData.nc);
      return frontendRedirect({ code: appCode });
    }

    // The web page gets a one-time code as well, bound to this browser's cookie
    // rather than a verifier. The session token itself only ever travels in the
    // body of the POST that redeems it, never in a URL.
    const webCode = oidc.issueWebCode(user.id, stateData.wb);
    return frontendRedirect({ oidc_code: webCode });
  } catch (err) {
    const { message, log } = oidc.describeFetchError(err);
    console.error('OIDC callback processing failed:', log);
    return frontendRedirect({ oidc_error: message });
  }
});

// The second half of the hand-off: trade a one-time code for a session. From the
// native app, the code from bindarr://oidc?code=... plus the verifier only the
// app holds. From the web page, the code from /?oidc_code=... plus the cookie set
// when this browser started the login. Public by necessity -- the caller is not
// signed in yet -- and rate limited like every other credential exchange. Same
// response shape as POST /login, so sign-in completes through the same path.
router.post('/oidc/exchange', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) {
    return res.status(404).json({ error: 'OIDC authentication is not enabled.' });
  }

  const { code, verifier } = req.body || {};
  let userId;
  if (verifier !== undefined) {
    userId = oidc.consumeNativeCode(code, verifier);
  } else {
    userId = oidc.consumeWebCode(code, oidc.readCookie(req.headers.cookie, oidc.WEB_BINDING_COOKIE));
    // One binding per login, spent by the first try at redeeming it.
    res.clearCookie(oidc.WEB_BINDING_COOKIE, { path: oidc.WEB_BINDING_PATH });
  }
  if (!userId) {
    return res.status(400).json({ error: 'This sign-in link is invalid or has expired. Please try again.' });
  }

  try {
    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (!user) {
      return res.status(400).json({ error: 'This sign-in link is invalid or has expired. Please try again.' });
    }
    const token = await generateSession(user.id);
    res.json({ message: 'Login successful', token, user: sessionUser(user) });
  } catch (error) {
    console.error('OIDC code exchange failed:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// The user object the client is handed -- by every sign-in path, GET /me and a
// settings save, so they can never drift apart. The SPA keeps it in localStorage,
// so it carries no secret: the provider keys and the API key are reported as set
// or not, never their values. The keys are write-only from the client's side, and
// the API key has its own on-demand read (GET /api-key).
function sessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    share_token: user.share_token,
    share_enabled: user.share_enabled,
    share_locations: user.share_locations,
    has_tcg_api_key: !!user.tcg_api_key,
    has_psa_api_token: !!user.psa_api_token,
    has_graded_price_api_key: !!user.graded_price_api_key,
    has_api_key: !!user.api_key,
    // The nav-bar tabs this user chose (null: the default set). Not a secret, and
    // carried here so the bar is right from the first frame after sign-in.
    nav_tabs: readNavTabs(user.nav_tabs)
  };
}

// First run: create the owner account. Open without auth by necessity, and safe
// only because it refuses the moment any account exists — there is nobody to ask
// for permission before the first user exists, and nothing to steal.
//
// The username is always `admin`, never the caller's choice: DEFAULT_ADMIN_PASSWORD
// has to hardcode it (an operator cannot log in as a name the server invented), so
// letting this path pick a different one would mean the owner account is named
// differently depending on which way the install started — and initDb's orphan-row
// adoption looks the account up by that name.
const OWNER_USERNAME = 'admin';

router.post('/bootstrap', authLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'A password is required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const row = await db.get(`SELECT COUNT(*) as count FROM users`);
    if (row.count > 0) {
      return res.status(409).json({ error: 'This instance is already set up. Log in instead.' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');
    const result = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [OWNER_USERNAME, passwordHash, 'admin', shareToken, 0]);

    // Both skipped by initDb, which found no account to hand them to.
    await db.adoptOrphanRows(result.lastID);
    await db.seedStarterLocations(result.lastID);

    const token = await generateSession(result.lastID);
    res.status(201).json({
      message: 'Setup complete',
      token,
      user: sessionUser({ username: OWNER_USERNAME, role: 'admin', share_token: shareToken, share_enabled: 0, share_locations: 0 })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create the owner account' });
  }
});

// A JSON body can carry any type, and these routes are unauthenticated: a number
// or object where a string belongs used to throw on `.trim()` outside the try,
// which took the whole process down. Reject it as a bad request instead.
function isCredential(value) {
  return typeof value === 'string' && value.length > 0;
}

// Register a new user
router.post('/register', authLimiter, async (req, res) => {
  if (!REGISTRATION_ENABLED) {
    return res.status(403).json({ error: 'Registration is disabled. Ask an administrator for an account.', code: 'registration_disabled' });
  }
  const { username, password } = req.body;
  if (!isCredential(username) || !isCredential(password)) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken', code: 'username_taken' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    const result = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, 'member', shareToken, 0]);

    const token = await generateSession(result.lastID);

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: sessionUser({ username: cleanUsername, role: 'member', share_token: shareToken, share_enabled: 0, share_locations: 0 })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Login user
router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!isCredential(username) || !isCredential(password)) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const cleanUsername = username.trim().toLowerCase();
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password', code: 'invalid_credentials' });
    }

    const token = await generateSession(user.id);

    res.json({
      message: 'Login successful',
      token,
      user: sessionUser(user)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout user
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // The session this request came in on. Stored hashed, so it is the hash the
    // middleware already computed that names the row.
    if (req.sessionTokenHash) {
      await db.run(`DELETE FROM sessions WHERE token = ?`, [req.sessionTokenHash]);
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user profile. The same secret-free shape as a sign-in (sessionUser):
// this used to return req.user whole, provider keys and API key included, and the
// SPA saved it to localStorage. id and oidc_sub ride along; neither is a secret.
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: { id: req.user.id, ...sessionUser(req.user), oidc_sub: req.user.oidc_sub } });
});

// The read-only API key itself, for Settings to show on request. Viewable again
// after it is made on purpose (see POST below), but only when asked for, so it
// never sits in the user object the SPA stores. A login session only, like the
// rest of account management. Stored as-is rather than hashed for the same
// reason: a hash could not be shown again.
router.get('/api-key', authenticateToken, (req, res) => {
  if (req.user.via_api_key) {
    return res.status(403).json({ error: 'Use a login session to view the API key.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ api_key: req.user.api_key || null });
});

// Issue (or rotate) this account's read-only API key — issue #33: a finance
// tracker needs a credential that outlives a login session. POST returns the key
// in full; it is also readable later from GET /api-key, deliberately, because a
// key that can only be seen once is a key people rotate until they catch it, and
// read-only is what keeps that acceptable.
router.post('/api-key', authenticateToken, async (req, res) => {
  try {
    const key = `bnd_${crypto.randomBytes(24).toString('hex')}`;
    await db.run(`UPDATE users SET api_key = ? WHERE id = ?`, [key, req.user.id]);
    res.json({ api_key: key });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/api-key', authenticateToken, async (req, res) => {
  try {
    await db.run(`UPDATE users SET api_key = NULL WHERE id = ?`, [req.user.id]);
    res.json({ message: 'API key revoked' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// The per-user provider keys PUT /settings writes, each with its own statement.
const PROVIDER_KEY_UPDATES = {
  tcg_api_key: `UPDATE users SET tcg_api_key = ? WHERE id = ?`,
  psa_api_token: `UPDATE users SET psa_api_token = ? WHERE id = ?`,
  graded_price_api_key: `UPDATE users SET graded_price_api_key = ? WHERE id = ?`
};

// Update settings (password, sharing)
router.put('/settings', authenticateToken, async (req, res) => {
  const { current_password, password, share_enabled, share_locations, regenerate_share_token } = req.body;

  let navTabs;
  if (req.body.nav_tabs !== undefined) {
    const parsed = parseNavTabs(req.body.nav_tabs);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    navTabs = parsed.value;
  }

  // Provider keys are write-only: a string sets one, '' (or null) clears it, and
  // leaving the field out leaves the key alone -- the client never has the current
  // value to send back. Checked before anything is written, so a bad field cannot
  // leave half a save behind.
  const keyUpdates = [];
  for (const [field, sql] of Object.entries(PROVIDER_KEY_UPDATES)) {
    const value = req.body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      return res.status(400).json({ error: 'API keys must be text.' });
    }
    keyUpdates.push([sql, (value || '').trim()]);
  }

  for (const [field, value] of Object.entries({ current_password, password })) {
    if (value !== undefined && typeof value !== 'string') {
      return res.status(400).json({ error: `${field} must be text` });
    }
  }

  try {
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const currentUser = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
      // 400, never 401: a 401 here read as "your session has expired", and the app
      // signed the user out for mistyping their current password.
      if (typeof current_password !== 'string' || !current_password || !verifyPassword(current_password, currentUser.password_hash)) {
        return res.status(400).json({ error: 'Current password is incorrect', code: 'wrong_password' });
      }
      const newHash = db.hashPassword(password);
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);
      // A password change is often because the old one got out, and whoever had it
      // may hold a session made with it. Sign out every other device; this one
      // stays, since it has just proved it knows the password.
      await revokeSessions(req.user.id, { exceptTokenHash: req.sessionTokenHash });
    }

    if (share_enabled !== undefined) {
      await db.run(`UPDATE users SET share_enabled = ? WHERE id = ?`, [share_enabled ? 1 : 0, req.user.id]);
    }

    if (share_locations !== undefined) {
      await db.run(`UPDATE users SET share_locations = ? WHERE id = ?`, [share_locations ? 1 : 0, req.user.id]);
    }

    for (const [sql, value] of keyUpdates) {
      await db.run(sql, [value, req.user.id]);
    }

    if (navTabs !== undefined) {
      await db.run(`UPDATE users SET nav_tabs = ? WHERE id = ?`, [navTabs, req.user.id]);
    }

    let newShareToken = req.user.share_token;
    if (regenerate_share_token) {
      newShareToken = crypto.randomBytes(16).toString('hex');
      await db.run(`UPDATE users SET share_token = ? WHERE id = ?`, [newShareToken, req.user.id]);
    }

    // Retrieve updated info
    const updatedUser = await db.get(`SELECT username, role, share_token, share_enabled, share_locations, tcg_api_key, psa_api_token, graded_price_api_key, api_key, nav_tabs FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      message: 'Settings updated successfully',
      user: sessionUser(updatedUser)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
