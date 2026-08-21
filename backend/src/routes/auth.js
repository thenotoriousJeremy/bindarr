const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, authLimiter } = require('../middleware/auth');
const { verifyPassword, generateSession } = require('../utils/authHelpers');
const oidc = require('../utils/oidc');

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

// Initiate OIDC / SSO authorization code flow
router.get('/oidc/login', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) {
    return res.status(404).json({ error: 'OIDC authentication is not enabled.' });
  }

  try {
    const authUrl = await oidc.buildAuthorizationUrl(req);
    res.redirect(302, authUrl);
  } catch (error) {
    console.error('OIDC login initiation failed:', error.message);
    res.status(500).json({ error: 'Failed to initiate OIDC login', message: error.message });
  }
});

// Handle OIDC / SSO callback from identity provider
router.get('/oidc/callback', authLimiter, async (req, res) => {
  if (!oidc.isOidcEnabled()) {
    return res.status(404).json({ error: 'OIDC authentication is not enabled.' });
  }

  const { code, state, error, error_description } = req.query;

  const frontendRedirect = (params) => {
    const baseUrl = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
    const qs = new URLSearchParams(params).toString();
    res.redirect(302, `${baseUrl}/?${qs}`);
  };

  if (error) {
    console.error(`OIDC IdP error: ${error} - ${error_description || ''}`);
    return frontendRedirect({ oidc_error: error_description || error });
  }

  if (!code || !state) {
    return frontendRedirect({ oidc_error: 'Missing authorization code or state from identity provider.' });
  }

  try {
    const { extracted } = await oidc.exchangeCode({ code, stateToken: state, req });
    const { sub, username } = extracted;

    // 1. Match by existing oidc_sub
    let user = await db.get(`SELECT * FROM users WHERE oidc_sub = ?`, [sub]);

    // 2. Fallback: match by username and link oidc_sub
    if (!user) {
      const existingUser = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
      if (existingUser) {
        await db.run(`UPDATE users SET oidc_sub = ? WHERE id = ?`, [sub, existingUser.id]);
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

    const token = await generateSession(user.id);
    return frontendRedirect({ oidc_token: token });
  } catch (err) {
    console.error('OIDC callback processing failed:', err.message);
    return frontendRedirect({ oidc_error: err.message });
  }
});

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
  if (!password) {
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
      user: {
        username: OWNER_USERNAME,
        role: 'admin',
        share_token: shareToken,
        share_enabled: 0,
        share_locations: 0,
        tcg_api_key: '',
        psa_api_token: '',
        graded_price_api_key: '',
        api_key: ''
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create the owner account' });
  }
});

// Register a new user
router.post('/register', authLimiter, async (req, res) => {
  if (!REGISTRATION_ENABLED) {
    return res.status(403).json({ error: 'Registration is disabled. Ask an administrator for an account.' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken' });
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
      user: {
        username: cleanUsername,
        role: 'member',
        share_token: shareToken,
        share_enabled: 0,
        share_locations: 0
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Login user
router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  try {
    const user = await db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = await generateSession(user.id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role,
        share_token: user.share_token,
        share_enabled: user.share_enabled,
        share_locations: user.share_locations,
        tcg_api_key: user.tcg_api_key || '',
        psa_api_token: user.psa_api_token || '',
        graded_price_api_key: user.graded_price_api_key || '',
        api_key: user.api_key || ''
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout user
router.post('/logout', authenticateToken, async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  try {
    if (token) {
      await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, (req, res) => {
  // An API key is a read-only credential for scripts. Handing it the account's
  // OTHER provider keys would make it a credential-theft tool: it can be pasted
  // into a dashboard config, and what leaks with it must stay read-only data.
  if (req.user.via_api_key) {
    const { tcg_api_key, psa_api_token, graded_price_api_key, ...safe } = req.user; // eslint-disable-line no-unused-vars
    return res.json({ user: safe });
  }
  res.json({ user: req.user });
});

// Issue (or rotate) this account's read-only API key — issue #33: a finance
// tracker needs a credential that outlives a login session. POST returns the key
// in full; it is also readable later from /me, deliberately, because a key that
// can only be seen once is a key people rotate until they catch it, and read-only
// is what keeps that acceptable.
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

// Update settings (password, sharing)
router.put('/settings', authenticateToken, async (req, res) => {
  const { current_password, password, share_enabled, share_locations, regenerate_share_token, tcg_api_key, psa_api_token, graded_price_api_key } = req.body;

  try {
    if (password !== undefined) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const currentUser = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
      if (!current_password || !verifyPassword(current_password, currentUser.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      const newHash = db.hashPassword(password);
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.user.id]);
    }

    if (share_enabled !== undefined) {
      await db.run(`UPDATE users SET share_enabled = ? WHERE id = ?`, [share_enabled ? 1 : 0, req.user.id]);
    }

    if (share_locations !== undefined) {
      await db.run(`UPDATE users SET share_locations = ? WHERE id = ?`, [share_locations ? 1 : 0, req.user.id]);
    }

    if (tcg_api_key !== undefined) {
      await db.run(`UPDATE users SET tcg_api_key = ? WHERE id = ?`, [tcg_api_key.trim(), req.user.id]);
    }

    if (psa_api_token !== undefined) {
      await db.run(`UPDATE users SET psa_api_token = ? WHERE id = ?`, [psa_api_token.trim(), req.user.id]);
    }

    if (graded_price_api_key !== undefined) {
      await db.run(`UPDATE users SET graded_price_api_key = ? WHERE id = ?`, [graded_price_api_key.trim(), req.user.id]);
    }

    let newShareToken = req.user.share_token;
    if (regenerate_share_token) {
      newShareToken = crypto.randomBytes(16).toString('hex');
      await db.run(`UPDATE users SET share_token = ? WHERE id = ?`, [newShareToken, req.user.id]);
    }

    // Retrieve updated info
    const updatedUser = await db.get(`SELECT username, role, share_token, share_enabled, share_locations, tcg_api_key, psa_api_token, graded_price_api_key, api_key FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      message: 'Settings updated successfully',
      user: {
        username: updatedUser.username,
        role: updatedUser.role,
        share_token: updatedUser.share_token,
        share_enabled: updatedUser.share_enabled,
        share_locations: updatedUser.share_locations,
        tcg_api_key: updatedUser.tcg_api_key || '',
        psa_api_token: updatedUser.psa_api_token || '',
        graded_price_api_key: updatedUser.graded_price_api_key || '',
        api_key: updatedUser.api_key || ''
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
