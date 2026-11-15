const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, authLimiter, loginLimiter, passwordLimiter } = require('../middleware/auth');
const { hashPassword, checkPassword, generateSession, revokeSessions, hashApiKey } = require('../utils/authHelpers');
const oidc = require('../utils/oidc');
const { parseNavTabs, readNavTabs } = require('../utils/navTabs');

const router = express.Router();

// Open self-registration is off by default: this is an invite-only app where an
// administrator creates accounts (Admin panel) and hands out credentials. Set
// ALLOW_REGISTRATION=true to let anyone self-register a member account.
const REGISTRATION_ENABLED = process.env.ALLOW_REGISTRATION === 'true';

// The running build's version (backend/package.json, which the release bumps), so
// the phone app can tell it is talking to an older server than it was built for.
const APP_VERSION = require('../../package.json').version;

// --- Claiming a fresh install -------------------------------------------------
//
// Until the owner account exists, whoever reaches the server first can create it
// (POST /bootstrap, or a first SSO sign-in), and /config says when that is open. A
// server exposed before its owner opens it could be claimed by a scanner. So the
// claim needs a one-time setup code, printed to the server log at boot
// (announceSetupCode) -- the log is something only whoever runs the server reads.
// SETUP_CODE sets it instead, for a scripted deploy.
//
// A request straight from this machine needs no code: loopback, and no proxy
// header saying it is really someone else's. That keeps a local install, and the
// test suites, as simple as they were. A TRUST_PROXY install has a proxy in front,
// so there a loopback connection is not taken to be the owner.
const SETUP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L to misread
const normalizeSetupCode = (value) => String(value == null ? '' : value).toUpperCase().replace(/[^0-9A-Z]/g, '');

function generateSetupCode() {
  let code = '';
  while (code.length < 12) {
    for (const byte of crypto.randomBytes(16)) {
      // Rejection sampling keeps every character equally likely.
      if (byte < 248 && code.length < 12) code += SETUP_ALPHABET[byte % SETUP_ALPHABET.length];
    }
  }
  return code.match(/.{4}/g).join('-');
}

let setupCode = null;
function currentSetupCode() {
  if (!setupCode) {
    const preset = normalizeSetupCode(process.env.SETUP_CODE);
    setupCode = preset ? { value: preset, preset: true } : (() => {
      const display = generateSetupCode();
      return { value: normalizeSetupCode(display), display, preset: false };
    })();
  }
  return setupCode;
}

function setupCodeMatches(candidate) {
  const given = normalizeSetupCode(candidate);
  if (!given) return false;
  const digest = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(given), digest(currentSetupCode().value));
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'];

function isDirectLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress;
  if (!remote || !LOOPBACK.test(remote)) return false;
  if (req.app && typeof req.app.get === 'function' && req.app.get('trust proxy')) return false;
  return !PROXY_HEADERS.some(header => req.headers[header] !== undefined);
}

// Why this request may not create the owner account, or null when it may.
function setupRefusal(req, code) {
  if (isDirectLoopback(req)) return null;
  if (code === undefined || code === null || code === '') return 'setup_code_required';
  return setupCodeMatches(code) ? null : 'setup_code_invalid';
}

const SETUP_ERRORS = {
  setup_code_required: 'Enter the setup code from the server log to create the owner account.',
  setup_code_invalid: 'That setup code is not the one in the server log.',
};

// Said once at boot (server.js), while there is no account yet.
async function announceSetupCode() {
  try {
    const row = await db.get(`SELECT COUNT(*) AS count FROM users`);
    if (row.count > 0) return;
    const code = currentSetupCode();
    if (code.preset) {
      if (code.value.length < 8) console.warn('SETUP: SETUP_CODE is shorter than 8 characters, which is easy to guess.');
      console.log('SETUP: no accounts yet. Creating the owner account from another machine takes the code SETUP_CODE sets.');
    } else {
      console.log(`SETUP: no accounts yet. Setup code: ${code.display}`);
      console.log('SETUP: enter it on the setup screen to create the owner account (not needed in a browser on this machine). A restart makes a new one; SETUP_CODE sets your own.');
    }
  } catch (error) {
    console.error('Could not check for a fresh install:', error.message);
  }
}

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
    // Whether the setup screen has to ask for the setup code (see above).
    setupCodeRequired: setupRequired && !isDirectLoopback(req),
    oidcEnabled: oidc.isOidcEnabled(),
    oidcProviderName: oidc.getProviderName(),
    version: APP_VERSION
  });
});

// Back to the page (or the app) that started an SSO sign-in, with `params` in the
// query: a one-time code, or an `oidc_error` code the client words for itself.
// Never free text: an identity provider's error description, or an exception's
// message, would put whatever it says in the URL and on the login screen.
function oidcReturn(res, native, params) {
  const qs = new URLSearchParams(params).toString();
  if (native) {
    // Declared by the app's intent-filter (Android) / CFBundleURLTypes (iOS).
    return res.redirect(302, `bindarr://oidc?${qs}`);
  }
  const baseUrl = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
  return res.redirect(302, `${baseUrl}/?${qs}`);
}

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
    // On an install with no account yet, this sign-in creates the owner, so it
    // needs what /bootstrap needs (see "Claiming a fresh install"). The code comes
    // as ?setup_code= and is checked here, before the identity provider is
    // involved; only the yes travels on, sealed into the signed state.
    let setup = false;
    const { count } = await db.get(`SELECT COUNT(*) AS count FROM users`);
    if (count === 0 && req.query.setup_code !== undefined) {
      if (!setupCodeMatches(req.query.setup_code)) return oidcReturn(res, !!nativeChallenge, { oidc_error: 'setup_code_invalid' });
      setup = true;
    }

    // A web login is tied to this browser by a cookie; the native app has its
    // verifier instead. See the web hand-off in utils/oidc.js.
    const webBinding = nativeChallenge ? null : oidc.createWebBinding();
    const authUrl = await oidc.buildAuthorizationUrl(req, {
      nativeChallenge,
      webBindingHash: webBinding ? webBinding.hash : undefined,
      setup
    });
    if (webBinding) res.cookie(oidc.WEB_BINDING_COOKIE, webBinding.secret, webBindingCookie(req));
    res.redirect(302, authUrl);
  } catch (error) {
    const { log } = oidc.describeFetchError(error);
    console.error('OIDC login initiation failed:', log);
    res.status(500).json({ error: 'Failed to initiate OIDC login' });
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

  // An `oidc_error` is always one of a few fixed codes (oidcReturn); the detail
  // goes to the log.
  const frontendRedirect = (params) => oidcReturn(res, native, params);

  if (error) {
    console.error(`OIDC IdP error: ${error} - ${error_description || ''}`);
    return frontendRedirect({ oidc_error: error === 'access_denied' ? 'access_denied' : 'idp_error' });
  }

  if (!code || !state) {
    return frontendRedirect({ oidc_error: 'missing_code' });
  }

  // A web login has to finish in the browser that started it. Without this, a
  // callback link from someone else's login -- their IdP code, their state --
  // opened in your browser would sign you into THEIR account (login CSRF). Checked
  // before the IdP is called, so a refused link costs nothing. A state that does
  // not verify at all falls through to exchangeCode, which says so.
  if (startedState && !native
    && !oidc.matchesWebBinding(oidc.readCookie(req.headers.cookie, oidc.WEB_BINDING_COOKIE), startedState.wb)) {
    return frontendRedirect({ oidc_error: 'browser_mismatch' });
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
        return frontendRedirect({ oidc_error: 'username_taken' });
      }
      if (existingUser) {
        // An account already bound to a DIFFERENT IdP identity is never re-bound.
        // Two subjects claiming one username is the collision this whole flag is
        // about, and silently moving the account to whoever logged in last is the
        // worst of the available answers.
        if (existingUser.oidc_sub && existingUser.oidc_sub !== sub) {
          console.warn(`OIDC: refusing to relink "${username}" — already bound to another identity.`);
          return frontendRedirect({ oidc_error: 'identity_conflict' });
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
        // Bootstrap instance owner via OIDC -- the same claim POST /bootstrap
        // makes, so the same gate: this machine, or the setup code /oidc/login
        // checked and sealed into the state (su). With an identity provider that
        // lets anyone sign up, the first stranger through would otherwise own it.
        if (!(stateData && stateData.su === 1) && !isDirectLoopback(req)) {
          console.warn('OIDC: refusing to create the owner account without the setup code (see the server log).');
          return frontendRedirect({ oidc_error: 'setup_code_required' });
        }
        const shareToken = crypto.randomBytes(16).toString('hex');
        const lockedHash = `oidc_locked:${crypto.randomBytes(16).toString('hex')}`;
        const result = await db.run(`
          INSERT INTO users (username, password_hash, role, share_token, share_enabled, oidc_sub)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [OWNER_USERNAME, lockedHash, 'admin', shareToken, 0, sub]);

        await db.adoptOrphanRows(result.lastID);
        await db.seedStarterLocations(result.lastID, { newAccount: true });
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

        await db.seedStarterLocations(result.lastID, { newAccount: true });
        user = await db.get(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
      } else {
        return frontendRedirect({ oidc_error: 'no_account' });
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
    const { log } = oidc.describeFetchError(err);
    console.error('OIDC callback processing failed:', log);
    // The ID token checks name what failed (oidc.validateIdTokenClaims); anything
    // else -- the token endpoint's answer, a network error -- stays in the log.
    return frontendRedirect({ oidc_error: (err && err.oidcCode) || 'sign_in_failed' });
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

// First run: create the owner account. Open without auth by necessity: it refuses
// the moment any account exists, and until then it takes the setup code from the
// server log, unless the request comes straight from this machine (see "Claiming
// a fresh install" above).
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
    const refusal = setupRefusal(req, req.body.setup_code);
    if (refusal) {
      return res.status(403).json({ error: SETUP_ERRORS[refusal], code: refusal });
    }

    const passwordHash = await hashPassword(password);
    // Checked again after the hash: two requests racing past the count above
    // would otherwise both create an owner.
    if ((await db.get(`SELECT COUNT(*) as count FROM users`)).count > 0) {
      return res.status(409).json({ error: 'This instance is already set up. Log in instead.' });
    }
    const shareToken = crypto.randomBytes(16).toString('hex');
    const result = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [OWNER_USERNAME, passwordHash, 'admin', shareToken, 0]);

    // Both skipped by initDb, which found no account to hand them to.
    await db.adoptOrphanRows(result.lastID);
    await db.seedStarterLocations(result.lastID, { newAccount: true });

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

    const passwordHash = await hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    const result = await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, 'member', shareToken, 0]);
    // A binder and a box to put the first card in, as every new account gets.
    await db.seedStarterLocations(result.lastID, { newAccount: true });

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
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!isCredential(username) || !isCredential(password)) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const cleanUsername = username.trim().toLowerCase();
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername]);
    // Checked whether or not the user exists: checkPassword does the same work
    // for no account (or an SSO-only one) as for a real password, so how long
    // this takes does not say which usernames are taken.
    const valid = await checkPassword(password, user ? user.password_hash : null);
    if (!user || !valid) {
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

// The API key used to be readable again here, which meant storing it as-is: a
// copy of the database, or an admin backup, then held a working key to every
// collection that had one. It is stored hashed now (authHelpers.hashApiKey) and
// shown once, by the POST that makes it. An older client asking for it is told so.
router.get('/api-key', authenticateToken, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(410).json({
    error: 'An API key is shown only once, when it is created. Replace the key to get a new one.',
    code: 'api_key_shown_once'
  });
});

// Issue (or rotate) this account's read-only API key — issue #33: a finance
// tracker needs a credential that outlives a login session. The response is the
// only time the key is ever shown: only its hash is kept. Losing it means
// replacing it, which read-only is what keeps cheap.
router.post('/api-key', authenticateToken, async (req, res) => {
  try {
    const key = `bnd_${crypto.randomBytes(24).toString('hex')}`;
    await db.run(`UPDATE users SET api_key = ? WHERE id = ?`, [hashApiKey(key), req.user.id]);
    res.set('Cache-Control', 'no-store');
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

// Update settings (password, sharing). passwordLimiter counts the wrong current
// passwords a password change is sent with, per account.
router.put('/settings', authenticateToken, passwordLimiter, async (req, res) => {
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
      if (typeof current_password !== 'string' || !current_password
        || !(await checkPassword(current_password, currentUser.password_hash))) {
        res.locals.wrongPassword = true;   // what passwordLimiter counts
        return res.status(400).json({ error: 'Current password is incorrect', code: 'wrong_password' });
      }
      const newHash = await hashPassword(password);
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
// server.js prints the setup code at boot, once the database can say whether any
// account exists. isDirectLoopback is exported for its tests.
module.exports.announceSetupCode = announceSetupCode;
module.exports.isDirectLoopback = isDirectLoopback;
