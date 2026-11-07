const express = require('express');
const db = require('../db');
const notify = require('../notify');
const { checkUrl, allowPrivate } = require('../utils/notifyGuard');
const { CHANNEL_TYPES } = require('../utils/notifyPayloads');

const router = express.Router();

const MAX_CHANNELS = 10;
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

// What the client is told about a channel. The URL and the token are write-only:
// a Discord webhook URL is the credential to post into that server, and the ntfy
// or webhook token is a password. The client gets has_url/has_token and, so the
// user can tell two channels apart, the host — never the path, which is where
// Discord and Apprise keep the secret. ntfy's server and topic are shown: the
// user needs the topic to subscribe, and the server is a bare base URL.
function publicChannel(ch) {
  let host = '';
  try { host = new URL(ch.url).host; } catch { /* stored before validation existed */ }
  return {
    id: ch.id,
    type: ch.type,
    name: ch.name || '',
    host,
    server_url: ch.type === 'ntfy' ? ch.url : undefined,
    topic: ch.type === 'ntfy' ? ch.topic : undefined,
    has_url: !!ch.url,
    has_token: !!ch.token,
    enabled: !!ch.enabled,
    events_price: !!ch.events_price,
    events_admin: !!ch.events_admin,
    last_status: ch.last_status || null,
    last_error: ch.last_status === 'failed' ? (ch.last_error || null) : null,
    last_at: ch.last_at || null,
    created_at: ch.created_at,
  };
}

const flag = (v) => (v ? 1 : 0);
const cleanText = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Validate a destination for its channel type. Throws a user-safe Error.
async function checkDestination(type, url) {
  const parsed = await checkUrl(url);
  if (type === 'discord') {
    if (parsed.protocol !== 'https:' || !DISCORD_HOSTS.includes(parsed.hostname.toLowerCase())
        || !parsed.pathname.startsWith('/api/webhooks/')) {
      throw new Error('That is not a Discord webhook URL (https://discord.com/api/webhooks/…).');
    }
  }
  return parsed.toString();
}

async function loadChannels(userId) {
  // The newest delivery per channel, so Settings can say "last send failed: HTTP 404".
  return db.all(`
    SELECT ch.*, l.status AS last_status, l.error AS last_error, l.created_at AS last_at
      FROM notification_channels ch
      LEFT JOIN notification_log l ON l.id = (
        SELECT id FROM notification_log WHERE channel_id = ch.id AND status <> 'pending' ORDER BY id DESC LIMIT 1)
     WHERE ch.user_id = ?
     ORDER BY ch.id
  `, [userId]);
}

async function ownChannel(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return null;
  return db.get(`SELECT * FROM notification_channels WHERE id = ? AND user_id = ?`, [id, req.user.id]);
}

async function wishlistSupported() {
  return !!(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_list_items'`));
}

router.get('/', async (req, res) => {
  try {
    const prefsRow = await db.get(`SELECT * FROM notification_prefs WHERE user_id = ?`, [req.user.id]);
    const prefs = { ...notify.DEFAULT_PREFS, ...(prefsRow || {}) };
    delete prefs.user_id;
    res.json({
      channels: (await loadChannels(req.user.id)).map(publicChannel),
      prefs: {
        price_enabled: !!prefs.price_enabled,
        price_pct: prefs.price_pct,
        price_abs: prefs.price_abs,
        min_price: prefs.min_price,
        include_wishlist: !!prefs.include_wishlist,
      },
      types: CHANNEL_TYPES,
      allow_private: allowPrivate(),
      wishlist_lists: await wishlistSupported(),
    });
  } catch (error) {
    console.error('Failed to load notification settings:', error);
    res.status(500).json({ error: 'Failed to load notification settings' });
  }
});

router.post('/channels', async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
  const topic = cleanText(b.topic, 64);
  if (type === 'ntfy' && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    return res.status(400).json({ error: 'An ntfy topic is 1–64 letters, digits, - or _.' });
  }
  try {
    const { n } = await db.get(`SELECT COUNT(*) AS n FROM notification_channels WHERE user_id = ?`, [req.user.id]);
    if (n >= MAX_CHANNELS) return res.status(400).json({ error: `At most ${MAX_CHANNELS} channels.` });
    let url;
    try {
      url = await checkDestination(type, b.url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const token = cleanText(b.token, 512) || null;
    const { lastID } = await db.run(
      `INSERT INTO notification_channels (user_id, type, name, url, topic, token, enabled, events_price, events_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, type, cleanText(b.name, 80) || null, url, type === 'ntfy' ? topic : null,
        type === 'discord' ? null : token,
        flag(b.enabled !== false), flag(b.events_price !== false),
        // Instance failures are only ever sent to admins; a member's channel
        // never subscribes to them.
        flag(req.user.role === 'admin' && b.events_admin !== false)]
    );
    const row = (await loadChannels(req.user.id)).find(c => c.id === lastID);
    res.status(201).json(publicChannel(row));
  } catch (error) {
    console.error('Failed to create notification channel:', error);
    res.status(500).json({ error: 'Failed to create notification channel' });
  }
});

// Partial update. A secret is replaced only when a new value is sent; an empty or
// missing url/token keeps the stored one (the client never has it to send back).
// clear_token removes the token.
router.put('/channels/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const ch = await ownChannel(req);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const sets = [];
    const vals = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push(cleanText(b.name, 80) || null); }
    if (b.url) {
      try {
        sets.push('url = ?'); vals.push(await checkDestination(ch.type, b.url));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (b.topic !== undefined && ch.type === 'ntfy') {
      const topic = cleanText(b.topic, 64);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return res.status(400).json({ error: 'An ntfy topic is 1–64 letters, digits, - or _.' });
      sets.push('topic = ?'); vals.push(topic);
    }
    if (ch.type !== 'discord') {
      if (b.clear_token) { sets.push('token = NULL'); }
      else if (b.token) { sets.push('token = ?'); vals.push(cleanText(b.token, 512)); }
    }
    if (b.enabled !== undefined) { sets.push('enabled = ?'); vals.push(flag(b.enabled)); }
    if (b.events_price !== undefined) { sets.push('events_price = ?'); vals.push(flag(b.events_price)); }
    if (b.events_admin !== undefined) { sets.push('events_admin = ?'); vals.push(flag(req.user.role === 'admin' && b.events_admin)); }
    if (sets.length) {
      await db.run(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...vals, ch.id, req.user.id]);
    }
    const row = (await loadChannels(req.user.id)).find(c => c.id === ch.id);
    res.json(publicChannel(row));
  } catch (error) {
    console.error('Failed to update notification channel:', error);
    res.status(500).json({ error: 'Failed to update notification channel' });
  }
});

router.delete('/channels/:id', async (req, res) => {
  try {
    const ch = await ownChannel(req);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    await db.run(`DELETE FROM notification_channels WHERE id = ? AND user_id = ?`, [ch.id, req.user.id]);
    res.json({ message: 'Channel deleted' });
  } catch (error) {
    console.error('Failed to delete notification channel:', error);
    res.status(500).json({ error: 'Failed to delete notification channel' });
  }
});

// A few test sends a minute per user. The button is the one way a member can make
// the server open a connection on demand, so it should not be a port scanner.
const TEST_WINDOW_MS = 60 * 1000;
const TEST_LIMIT = 5;
const testCalls = new Map();   // user id -> recent timestamps

router.post('/channels/:id/test', async (req, res) => {
  const now = Date.now();
  const recent = (testCalls.get(req.user.id) || []).filter(t => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) return res.status(429).json({ error: 'Too many test sends. Try again in a minute.' });
  recent.push(now);
  testCalls.set(req.user.id, recent);
  try {
    const ch = await ownChannel(req);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      await notify.sendTest(ch);
    } catch (err) {
      // The status line or the guard's reason only. Never the receiver's response
      // body: echoing it would let the test button read pages off the network.
      return res.status(502).json({ error: `Send failed: ${err.message}` });
    }
    res.json({ message: 'Test notification sent' });
  } catch (error) {
    console.error('Failed to send test notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

const num = (v, min, max) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
};

router.put('/prefs', async (req, res) => {
  const b = req.body || {};
  const pct = num(b.price_pct, 0, 1000);
  const abs = num(b.price_abs, 0, 1000000);
  const min = num(b.min_price, 0, 1000000);
  if (pct === undefined || abs === undefined || min === undefined) {
    return res.status(400).json({ error: 'Thresholds must be non-negative numbers' });
  }
  try {
    await db.run(
      `INSERT INTO notification_prefs (user_id, price_enabled, price_pct, price_abs, min_price, include_wishlist)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET price_enabled = excluded.price_enabled, price_pct = excluded.price_pct,
         price_abs = excluded.price_abs, min_price = excluded.min_price, include_wishlist = excluded.include_wishlist`,
      [req.user.id, flag(b.price_enabled !== false), pct, abs, min, flag(b.include_wishlist !== false)]
    );
    res.json({ message: 'Notification settings saved' });
  } catch (error) {
    console.error('Failed to save notification settings:', error);
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

module.exports = router;
