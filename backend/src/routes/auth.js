const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, authLimiter } = require('../middleware/auth');
const { verifyPassword, generateSession } = require('../utils/authHelpers');

const router = express.Router();

// Open self-registration is off by default: this is an invite-only app where an
// administrator creates accounts (Admin panel) and hands out credentials. Set
// ALLOW_REGISTRATION=true to let anyone self-register a member account.
const REGISTRATION_ENABLED = process.env.ALLOW_REGISTRATION === 'true';

// Public config the login screen reads to decide whether to show the Sign Up
// option. No auth — must be reachable before login.
router.get('/config', (req, res) => {
  res.json({ registrationEnabled: REGISTRATION_ENABLED });
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
        share_enabled: 0
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
        tcg_api_key: user.tcg_api_key || ''
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
  res.json({ user: req.user });
});

// Update settings (password, sharing)
router.put('/settings', authenticateToken, async (req, res) => {
  const { current_password, password, share_enabled, regenerate_share_token, tcg_api_key } = req.body;

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

    if (tcg_api_key !== undefined) {
      await db.run(`UPDATE users SET tcg_api_key = ? WHERE id = ?`, [tcg_api_key.trim(), req.user.id]);
    }

    let newShareToken = req.user.share_token;
    if (regenerate_share_token) {
      newShareToken = crypto.randomBytes(16).toString('hex');
      await db.run(`UPDATE users SET share_token = ? WHERE id = ?`, [newShareToken, req.user.id]);
    }

    // Retrieve updated info
    const updatedUser = await db.get(`SELECT username, role, share_token, share_enabled, tcg_api_key FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      message: 'Settings updated successfully',
      user: {
        username: updatedUser.username,
        role: updatedUser.role,
        share_token: updatedUser.share_token,
        share_enabled: updatedUser.share_enabled,
        tcg_api_key: updatedUser.tcg_api_key || ''
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
