// Notifications: price moves for every user, background-job failures for admins.
//
// The whole surface the rest of the backend sees is one call:
//
//     require('./notify').emit({ type: 'backup_failed', error: err.message });
//
// emit() returns at once and cannot throw. Everything after it — deciding who
// hears about it, writing the message, the network — happens later, off the
// caller's path, because the callers are a price sweep, a backup and a catalog
// build, and none of them should wait on (or fail because of) somebody's Discord.
//
// Events:
//   price_sweep_done      { summary? } a round of price sweeps finished (the
//                         utils/priceSweeps summary); look for price moves
//   price_sweep_failed    { source, error }     admins only
//   backup_failed         { error }             admins only
//   catalog_build_failed  { game, lang, error } admins only
//
// Delivery goes through notification_log, which is the queue as well as the
// record: a message is inserted 'pending', the worker POSTs it, and a failure is
// retried with backoff until MAX_ATTEMPTS. Pending rows survive a restart.
const http = require('http');
const https = require('https');
const db = require('./db');
const { checkUrl, guardedLookup } = require('./utils/notifyGuard');
const payloads = require('./utils/notifyPayloads');

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30 * 1000;           // 30s, 2m, 8m, 32m, then the cap
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// A card is not reported twice inside this window, however far it moves: the
// sweeps run hourly and a provider can flap a price back and forth within a day.
const PRICE_COOLDOWN_MS = 20 * 60 * 60 * 1000;
// The same admin failure (same job, same source) is reported once per window.
// A sweep that fails every hour should be one message, not twenty-four.
const ADMIN_DEDUPE_MS = 6 * 60 * 60 * 1000;
const ADMIN_EVENTS = ['price_sweep_failed', 'backup_failed', 'catalog_build_failed'];

const DEFAULT_PREFS = { price_enabled: 1, price_pct: 15, price_abs: 5, min_price: 1, include_wishlist: 1 };

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// --- HTTP --------------------------------------------------------------------

// POST JSON, through the SSRF guard. Never follows a redirect (a public URL that
// 302s to a private one would otherwise walk straight past the guard), and reads
// at most MAX_RESPONSE_BYTES of whatever comes back. Resolves { status, headers,
// text }; rejects on network failure, timeout or a blocked address.
async function post(rawUrl, body, headers = {}, timeoutMs = SEND_TIMEOUT_MS) {
  // IP-literal hosts never reach a DNS lookup, so guardedLookup alone would wave
  // them through. checkUrl without resolving judges the literal (and "localhost").
  const url = await checkUrl(rawUrl, { resolve: false });
  const data = Buffer.from(JSON.stringify(body));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': data.length },
      lookup: guardedLookup,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < MAX_RESPONSE_BYTES) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// Discord rate limits, per channel: the time before which nothing more may be
// sent to it. Set from a 429's retry_after and, pre-emptively, from the
// X-RateLimit-Remaining: 0 / X-RateLimit-Reset-After headers on a success.
const blockedUntil = new Map();

function retryAfterMs(res) {
  try {
    const j = JSON.parse(res.text);
    if (j && Number(j.retry_after) > 0) return Math.ceil(Number(j.retry_after) * 1000);
  } catch { /* not JSON */ }
  const h = Number(res.headers['retry-after']);
  return h > 0 ? Math.ceil(h * 1000) : 5000;
}

// Send one message to one channel. Resolves on a 2xx; otherwise rejects with an
// Error whose message is safe to store and show — it never contains the URL,
// which for Discord is the credential — and, for a 429, `retryAfterMs`.
async function send(channel, message) {
  const { url, body, headers } = payloads.buildRequest(channel, message);
  let res;
  try {
    res = await post(url, body, headers);
  } catch (err) {
    throw new Error(clip(err.code === 'NOTIFY_BLOCKED' ? err.message : `${err.code || 'error'}: ${err.message}`, 300));
  }
  if (channel.type === 'discord' && res.headers['x-ratelimit-remaining'] === '0') {
    const after = Number(res.headers['x-ratelimit-reset-after']);
    if (after > 0) blockedUntil.set(channel.id, Date.now() + Math.ceil(after * 1000));
  }
  if (res.status >= 200 && res.status < 300) return;
  const err = new Error(`HTTP ${res.status}`);
  if (res.status === 429) {
    err.retryAfterMs = retryAfterMs(res);
    blockedUntil.set(channel.id, Date.now() + err.retryAfterMs);
  }
  throw err;
}

// --- queue -------------------------------------------------------------------

const backoffMs = (attempts) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 4 ** Math.max(0, attempts - 1));

async function enqueue(userId, channelId, message, dedupeKey = null) {
  await db.run(
    `INSERT INTO notification_log (user_id, channel_id, event_type, dedupe_key, payload, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [userId, channelId, message.type, dedupeKey, JSON.stringify(message), Date.now()]
  );
}

let working = null;
let again = false;
let timer = null;
let stopped = false;

async function deliver(row) {
  const channel = await db.get(`SELECT * FROM notification_channels WHERE id = ? AND user_id = ?`, [row.channel_id, row.user_id]);
  if (!channel || !channel.enabled) {
    await db.run(`UPDATE notification_log SET status = 'dropped', error = ? WHERE id = ?`,
      [channel ? 'channel disabled' : 'channel deleted', row.id]);
    return;
  }
  const wait = (blockedUntil.get(channel.id) || 0) - Date.now();
  if (wait > 0) {
    // Rate-limited: not an attempt, just later.
    await db.run(`UPDATE notification_log SET next_attempt_at = ? WHERE id = ?`, [Date.now() + wait, row.id]);
    return;
  }
  try {
    await send(channel, JSON.parse(row.payload));
    await db.run(
      `UPDATE notification_log SET status = 'sent', attempts = attempts + 1, error = NULL, sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [row.id]
    );
  } catch (err) {
    // A 429 is Discord asking us to wait, not the channel failing: it does not use
    // up an attempt.
    const attempts = row.attempts + (err.retryAfterMs ? 0 : 1);
    const failed = attempts >= MAX_ATTEMPTS;
    await db.run(
      `UPDATE notification_log SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?`,
      [failed ? 'failed' : 'pending', attempts, clip(err.message, 300),
        Date.now() + (err.retryAfterMs || backoffMs(attempts)), row.id]
    );
    if (failed) console.warn(`notify: giving up on message ${row.id} to channel ${channel.id} after ${attempts} attempts: ${err.message}`);
  }
}

async function drain() {
  for (;;) {
    const rows = await db.all(
      `SELECT * FROM notification_log WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 50`,
      [Date.now()]
    );
    if (!rows.length || stopped) return;
    for (const row of rows) {
      if (stopped) return;
      await deliver(row);
    }
  }
}

// Wake for the earliest retry still waiting. unref'd: an idle queue must not keep
// the process (or a test) alive.
async function scheduleNext() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (stopped) return;
  const row = await db.get(`SELECT MIN(next_attempt_at) AS at FROM notification_log WHERE status = 'pending'`);
  if (!row || row.at == null) return;
  timer = setTimeout(() => { timer = null; kick(); }, Math.max(0, row.at - Date.now()) + 50);
  if (timer.unref) timer.unref();
}

// Run the queue now. Single-flight: a kick while it is running makes it go round
// once more instead of starting a second worker. Resolves when idle; never rejects.
function kick() {
  if (working) { again = true; return working; }
  working = (async () => {
    do {
      again = false;
      await drain();
    } while (again && !stopped);
    await scheduleNext();
  })().catch(err => console.error('notify: queue failed:', err.message))
    .finally(() => { working = null; });
  return working;
}

// --- price moves ---------------------------------------------------------------

async function prefsFor(userId) {
  const row = await db.get(`SELECT * FROM notification_prefs WHERE user_id = ?`, [userId]);
  return { ...DEFAULT_PREFS, ...(row || {}) };
}

// Is the card-lists feature's wishlist table here? It lands on its own branch, so
// this code works with or without it.
async function hasCardLists() {
  const row = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_list_items'`);
  return !!row;
}

// Every card this user owns or (optionally) wants, with its latest recorded price
// and the price they were last told about.
async function watchedCards(userId, includeWishlist) {
  const sources = [`SELECT card_id, 'owned' AS source FROM collection WHERE user_id = ? AND COALESCE(list_type, 'collection') = 'collection'`];
  const params = [userId];
  if (includeWishlist) {
    sources.push(`SELECT card_id, 'wishlist' FROM collection WHERE user_id = ? AND list_type = 'wishlist'`);
    params.push(userId);
    if (await hasCardLists()) {
      sources.push(`SELECT i.card_id, 'wishlist' FROM card_list_items i JOIN card_lists l ON l.id = i.list_id
                     WHERE l.user_id = ? AND l.kind = 'wishlist'`);
      params.push(userId);
    }
  }
  // MIN(source) picks 'owned' over 'wishlist' for a card that is both.
  return db.all(`
    SELECT w.card_id, w.source, cc.name, cc.set_name, cc.game,
           ph.price, COALESCE(ph.currency, cc.price_currency, 'USD') AS currency,
           s.price AS base_price, s.currency AS base_currency, s.notified_at
      FROM (SELECT card_id, MIN(source) AS source FROM (${sources.join(' UNION ALL ')}) GROUP BY card_id) w
      JOIN card_cache cc ON cc.id = w.card_id
      JOIN price_history ph ON ph.card_id = w.card_id
       AND ph.recorded_at = (SELECT MAX(recorded_at) FROM price_history WHERE card_id = w.card_id)
      LEFT JOIN notification_price_state s ON s.user_id = ? AND s.card_id = w.card_id
  `, [...params, userId]);
}

// Has this card moved far enough, since the price the user was last told about,
// to tell them again? Pure, so the thresholds are testable on their own.
//   either bar clears it: |change| > price_pct percent, or |change| > price_abs
//   a NULL/0 bar is off; the percentage bar ignores cards under min_price
function isMove(base, price, prefs) {
  if (!(base > 0) || !(price > 0) || base === price) return false;
  const diff = Math.abs(price - base);
  const pct = (diff / base) * 100;
  const pctOn = Number(prefs.price_pct) > 0;
  const absOn = Number(prefs.price_abs) > 0;
  const bigEnough = Math.max(base, price) >= (Number(prefs.min_price) || 0);
  return (pctOn && bigEnough && pct > Number(prefs.price_pct)) || (absOn && diff > Number(prefs.price_abs));
}

// One user's price check. Returns the moves it queued a message about.
async function checkUserPrices(userId, channels, now = Date.now()) {
  const prefs = await prefsFor(userId);
  if (!prefs.price_enabled) return [];
  const rows = await watchedCards(userId, !!prefs.include_wishlist);
  const moves = [];
  const baselines = [];   // [card_id, price, currency, notified_at]
  for (const r of rows) {
    // First sight, or the card changed currency (an MTG price-source switch): this
    // price becomes the baseline. Nothing to compare a new series against.
    if (r.base_price == null || (r.base_currency || r.currency) !== r.currency) {
      baselines.push([r.card_id, r.price, r.currency, r.notified_at || null]);
      continue;
    }
    if (!isMove(r.base_price, r.price, prefs)) continue;
    const last = r.notified_at ? new Date(r.notified_at).getTime() : 0;
    if (now - last < PRICE_COOLDOWN_MS) continue;   // keep the old baseline
    moves.push({
      card_id: r.card_id, name: r.name, set_name: r.set_name, game: r.game, source: r.source,
      old_price: r.base_price, new_price: r.price, currency: r.currency,
    });
    baselines.push([r.card_id, r.price, r.currency, new Date(now).toISOString()]);
  }
  if (!baselines.length) return [];
  moves.sort((a, b) => Math.abs(b.new_price / b.old_price - 1) - Math.abs(a.new_price / a.old_price - 1));
  // The new baselines and the queued message commit together: a crash between
  // them can neither lose a move nor report it twice.
  await db.withTransaction(async () => {
    for (const b of baselines) {
      await db.run(
        `INSERT INTO notification_price_state (user_id, card_id, price, currency, notified_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, card_id) DO UPDATE SET price = excluded.price, currency = excluded.currency, notified_at = excluded.notified_at`,
        [userId, ...b]
      );
    }
    if (moves.length) {
      const message = payloads.priceMovesMessage(moves);
      for (const ch of channels) await enqueue(userId, ch.id, message, 'price_moves');
    }
  });
  return moves;
}

let pricing = null;
let priceAgain = false;

// Look for price moves for every user with a channel listening for them. Run after
// each round of sweeps; single-flight like the queue.
function checkPriceMoves() {
  if (pricing) { priceAgain = true; return pricing; }
  pricing = (async () => {
    do {
      priceAgain = false;
      const channels = await db.all(
        `SELECT id, user_id FROM notification_channels WHERE enabled = 1 AND events_price = 1 ORDER BY user_id, id`
      );
      const byUser = new Map();
      for (const ch of channels) {
        if (!byUser.has(ch.user_id)) byUser.set(ch.user_id, []);
        byUser.get(ch.user_id).push(ch);
      }
      let queued = 0;
      for (const [userId, chans] of byUser) {
        try {
          if ((await checkUserPrices(userId, chans)).length) queued++;
        } catch (err) {
          console.error(`notify: price check for user ${userId} failed:`, err.message);
        }
      }
      if (queued) kick();
    } while (priceAgain && !stopped);
  })().catch(err => console.error('notify: price check failed:', err.message))
    .finally(() => { pricing = null; });
  return pricing;
}

// --- admin events --------------------------------------------------------------

// One at a time: two copies of the same failure emitted together would otherwise
// both find no recent log row and both be sent.
let adminChain = Promise.resolve();
function notifyAdmins(event) {
  const run = adminChain.then(() => queueAdminEvent(event));
  adminChain = run.catch(() => {});
  return run;
}

async function queueAdminEvent(event) {
  const message = payloads.adminMessage(event);
  if (!message) return 0;
  const dedupeKey = [event.type, event.source, event.game, event.lang].filter(Boolean).join(':');
  // events_admin is only honoured for accounts that are admins NOW, so a demoted
  // admin's channels stop hearing about the instance without anyone editing them.
  const channels = await db.all(
    `SELECT ch.id, ch.user_id FROM notification_channels ch JOIN users u ON u.id = ch.user_id
      WHERE ch.enabled = 1 AND ch.events_admin = 1 AND u.role = 'admin'`
  );
  const since = new Date(Date.now() - ADMIN_DEDUPE_MS).toISOString().replace('T', ' ').slice(0, 19);
  let queued = 0;
  const seen = new Map();
  for (const ch of channels) {
    if (!seen.has(ch.user_id)) {
      const recent = await db.get(
        `SELECT 1 FROM notification_log WHERE user_id = ? AND dedupe_key = ? AND created_at >= ? LIMIT 1`,
        [ch.user_id, dedupeKey, since]
      );
      seen.set(ch.user_id, !!recent);
    }
    if (seen.get(ch.user_id)) continue;
    await enqueue(ch.user_id, ch.id, message, dedupeKey);
    queued++;
  }
  if (queued) kick();
  return queued;
}

// --- entry points --------------------------------------------------------------

async function handle(event) {
  if (!event || stopped) return;
  if (event.type === 'price_sweep_done') {
    // utils/priceSweeps' summary, when there is one. Most sweeps catch their own
    // errors and emit price_sweep_failed themselves; this catches one that threw.
    const summary = event.summary || {};
    if (summary.skipped) return;   // another run was still going; it will report
    for (const s of summary.sweeps || []) {
      if (s.status === 'error') await notifyAdmins({ type: 'price_sweep_failed', source: s.key, error: s.error });
    }
    return checkPriceMoves();
  }
  if (ADMIN_EVENTS.includes(event.type)) return notifyAdmins(event);
}

// Fire and forget. Returns immediately; never throws, never rejects.
function emit(event) {
  setImmediate(() => {
    handle(event).catch(err => console.error(`notify: ${event && event.type} failed:`, err.message));
  });
}

// Resume whatever was still queued when the server last stopped.
function start() {
  stopped = false;
  kick();
}

function stop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}

// Send a test message straight away, for the Settings "Send test" button. The one
// path that waits on the network, because the person who pressed it is waiting
// for the answer. Recorded in the log like any other delivery.
async function sendTest(channel) {
  const message = payloads.testMessage();
  try {
    await send(channel, message);
    await db.run(
      `INSERT INTO notification_log (user_id, channel_id, event_type, payload, status, attempts, sent_at)
       VALUES (?, ?, 'test', ?, 'sent', 1, CURRENT_TIMESTAMP)`,
      [channel.user_id, channel.id, JSON.stringify(message)]
    );
  } catch (err) {
    await db.run(
      `INSERT INTO notification_log (user_id, channel_id, event_type, payload, status, attempts, error)
       VALUES (?, ?, 'test', ?, 'failed', 1, ?)`,
      [channel.user_id, channel.id, JSON.stringify(message), clip(err.message, 300)]
    );
    throw err;
  }
}

// For tests: run the queue and the price check to completion.
async function flush() {
  if (pricing) await pricing;
  await kick();
}

module.exports = {
  emit, start, stop, flush, sendTest, send, post, isMove, checkPriceMoves, checkUserPrices, notifyAdmins, kick,
  DEFAULT_PREFS, MAX_ATTEMPTS, PRICE_COOLDOWN_MS, ADMIN_DEDUPE_MS,
  _blockedUntil: blockedUntil,
};
