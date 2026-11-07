// Notifications: channel payloads, the SSRF guard, thresholds, dedupe, delivery
// retries, cross-user isolation, and secrets never leaving the server.
//
// Everything is sent to a mock HTTP receiver on 127.0.0.1 — never to Discord,
// ntfy or anything else real. The guard blocks loopback by default, so the
// delivery tests run with NOTIFY_ALLOW_PRIVATE=true and the guard tests switch it
// off again. No framework — plain node + assert. Run: `node test/notify.test.js`
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-notify-${process.pid}.db`);
const db = require('../src/db');
const notify = require('../src/notify');
const guard = require('../src/utils/notifyGuard');
const payloads = require('../src/utils/notifyPayloads');
const notificationRoutes = require('../src/routes/notifications');

// --- mock receiver ---
const received = [];
let responder = () => ({ status: 204 });
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    received.push({ path: req.url, headers: req.headers, body: json });
    const r = responder(req) || { status: 204 };
    res.writeHead(r.status, r.headers || {});
    res.end(r.body || '');
  });
});

// --- the router behind a stand-in for the auth gate ---
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  req.user = { id, role: req.headers['x-test-role'] || 'member' };
  next();
});
app.use('/api/notifications', notificationRoutes);

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
let base;
let mock;

async function api(method, url, userId, body, role = 'member') {
  const res = await fetch(`${base}/api/notifications${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': String(userId), 'x-test-role': role },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

async function addUser(name, role = 'member') {
  return (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', ?, ?)`,
    [name, role, `tok-${name}`]
  )).lastID;
}

async function addChannel(userId, type, extra = {}) {
  const row = {
    url: `${mock}/${type}/${userId}/SECRETPATH`, topic: type === 'ntfy' ? 'cards' : null, token: null,
    events_price: 1, events_admin: 1, enabled: 1, ...extra,
  };
  return (await db.run(
    `INSERT INTO notification_channels (user_id, type, url, topic, token, enabled, events_price, events_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, row.url, row.topic, row.token, row.enabled, row.events_price, row.events_admin]
  )).lastID;
}

async function card(id, name, currency = 'USD') {
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, set_name, game, price_currency) VALUES (?, ?, 'Test Set', 'mtg', ?)`,
    [id, name, currency]
  );
}
let tick = 0;
async function price(cardId, value, currency = 'USD') {
  tick++;
  await db.run(
    `INSERT INTO price_history (card_id, price, currency, recorded_at) VALUES (?, ?, ?, datetime('2026-01-01', '+${tick} minutes'))`,
    [cardId, value, currency]
  );
}
async function own(userId, cardId, listType = 'collection') {
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type, game) VALUES (?, ?, 1, ?, 'mtg')`, [cardId, userId, listType]);
}

const pending = async () => (await db.get(`SELECT COUNT(*) n FROM notification_log WHERE status = 'pending'`)).n;
const logFor = (userId) => db.all(`SELECT * FROM notification_log WHERE user_id = ? ORDER BY id`, [userId]);

async function main() {
  await db.initDb();
  mock = `http://127.0.0.1:${await listen(receiver)}`;
  const apiServer = http.createServer(app);
  base = `http://127.0.0.1:${await listen(apiServer)}`;

  // ---------------------------------------------------------------- SSRF guard
  delete process.env.NOTIFY_ALLOW_PRIVATE;
  for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1',
    '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1']) {
    assert.ok(guard.addressProblem(addr), `${addr} must be blocked by default`);
  }
  for (const addr of ['169.254.169.254', 'fe80::1', '0.0.0.0', '224.0.0.1', '::']) {
    assert.ok(guard.addressProblem(addr), `${addr} must always be blocked`);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.strictEqual(guard.addressProblem(addr), null, `${addr} is public`);
  }
  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'not a url',
    'http://user:pw@example.com/', 'http://127.0.0.1:9/', 'http://[::1]/', 'http://localhost/', 'http://foo.localhost/',
    'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f000001/']) {
    await assert.rejects(guard.checkUrl(bad), `${bad} must be refused`);
  }
  // The socket-level check: a hostname that resolves to loopback is refused at
  // connect time even though no literal IP is in the URL.
  await new Promise(resolve => guard.guardedLookup('localhost', {}, (err) => {
    assert.ok(err && err.code === 'NOTIFY_BLOCKED', 'localhost must fail the connect-time lookup');
    resolve();
  }));
  // And a send to the mock is refused before a byte leaves.
  received.length = 0;
  await assert.rejects(notify.post(`${mock}/blocked`, {}), /blocked|NOTIFY/i);
  assert.strictEqual(received.length, 0, 'a blocked destination must not be contacted');

  process.env.NOTIFY_ALLOW_PRIVATE = 'true';
  assert.strictEqual(guard.addressProblem('127.0.0.1'), null, 'the flag allows loopback');
  assert.strictEqual(guard.addressProblem('192.168.1.10'), null, 'the flag allows the LAN');
  assert.ok(guard.addressProblem('169.254.169.254'), 'the flag never unlocks link-local/metadata');
  await guard.checkUrl(`${mock}/ok`);
  await assert.rejects(guard.checkUrl('http://169.254.169.254/'), 'metadata stays blocked with the flag');

  // Redirects are not followed: a public URL cannot bounce the server elsewhere.
  received.length = 0;
  responder = () => ({ status: 302, headers: { Location: `${mock}/elsewhere` } });
  await assert.rejects(notify.send({ id: -1, type: 'webhook', url: `${mock}/redirect` }, payloads.testMessage()), /HTTP 302/);
  assert.strictEqual(received.length, 1, 'the redirect target must not be requested');
  responder = () => ({ status: 204 });
  console.log('PASS: SSRF guard');

  const alice = await addUser('alice', 'admin');
  const bob = await addUser('bob');

  // ------------------------------------------------------------ route validation
  delete process.env.NOTIFY_ALLOW_PRIVATE;
  let r = await api('POST', '/channels', alice, { type: 'webhook', url: `${mock}/hook` });
  assert.strictEqual(r.status, 400, 'a loopback webhook is refused without the flag');
  assert.match(r.json.error, /NOTIFY_ALLOW_PRIVATE/);
  r = await api('POST', '/channels', alice, { type: 'discord', url: 'https://example.com/api/webhooks/1/abc' });
  assert.strictEqual(r.status, 400, 'a Discord channel must point at Discord');
  r = await api('POST', '/channels', alice, { type: 'webhook', url: 'file:///etc/passwd' });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/channels', alice, { type: 'sms', url: 'https://example.com' });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/channels', alice, { type: 'ntfy', url: `${mock}`, topic: 'bad topic!' });
  assert.strictEqual(r.status, 400);
  process.env.NOTIFY_ALLOW_PRIVATE = 'true';
  console.log('PASS: route URL validation');

  // ---------------------------------------------------- secrets never returned
  r = await api('POST', '/channels', alice, { type: 'webhook', name: 'Hook', url: `${mock}/hook/SECRETPATH`, token: 'SECRETTOKEN' }, 'admin');
  assert.strictEqual(r.status, 201, r.text);
  const aliceHook = r.json.id;
  r = await api('POST', '/channels', alice, { type: 'ntfy', url: `${mock}/`, topic: 'alice-cards', token: 'NTFYTOKEN' }, 'admin');
  assert.strictEqual(r.status, 201, r.text);
  const aliceNtfy = r.json.id;
  for (const text of [r.text, (await api('GET', '/', alice, null, 'admin')).text,
    (await api('PUT', `/channels/${aliceHook}`, alice, { name: 'Renamed' }, 'admin')).text]) {
    assert.ok(!text.includes('SECRETPATH'), 'the webhook URL path must never be returned');
    assert.ok(!text.includes('SECRETTOKEN') && !text.includes('NTFYTOKEN'), 'tokens must never be returned');
  }
  r = await api('GET', '/', alice, null, 'admin');
  const hookOut = r.json.channels.find(c => c.id === aliceHook);
  assert.strictEqual(hookOut.has_url, true);
  assert.strictEqual(hookOut.has_token, true);
  assert.strictEqual(hookOut.url, undefined);
  assert.strictEqual(hookOut.token, undefined);
  assert.strictEqual(hookOut.name, 'Renamed');
  assert.strictEqual(r.json.channels.find(c => c.id === aliceNtfy).topic, 'alice-cards', 'the ntfy topic is shown');
  // An update without a secret keeps the stored one; clear_token removes it.
  await api('PUT', `/channels/${aliceHook}`, alice, { url: '', token: '' }, 'admin');
  let stored = await db.get(`SELECT url, token FROM notification_channels WHERE id = ?`, [aliceHook]);
  assert.ok(stored.url.endsWith('/hook/SECRETPATH') && stored.token === 'SECRETTOKEN', 'blank fields keep the secrets');
  await api('PUT', `/channels/${aliceHook}`, alice, { clear_token: true }, 'admin');
  stored = await db.get(`SELECT token FROM notification_channels WHERE id = ?`, [aliceHook]);
  assert.strictEqual(stored.token, null);
  await api('PUT', `/channels/${aliceHook}`, alice, { token: 'SECRETTOKEN' }, 'admin');
  console.log('PASS: secrets are write-only');

  // ------------------------------------------------------ cross-user isolation
  r = await api('POST', '/channels', bob, { type: 'webhook', url: `${mock}/bob`, events_admin: true });
  assert.strictEqual(r.status, 201);
  const bobHook = r.json.id;
  assert.strictEqual(r.json.events_admin, false, 'a member cannot subscribe to instance failures');
  r = await api('GET', '/', bob);
  assert.deepStrictEqual(r.json.channels.map(c => c.id), [bobHook], 'bob sees only his channel');
  for (const [method, url, body] of [['PUT', `/channels/${aliceHook}`, { url: `${mock}/stolen` }],
    ['DELETE', `/channels/${aliceHook}`], ['POST', `/channels/${aliceHook}/test`]]) {
    r = await api(method, url, bob, body);
    assert.strictEqual(r.status, 404, `bob ${method} ${url} must 404`);
  }
  stored = await db.get(`SELECT url FROM notification_channels WHERE id = ?`, [aliceHook]);
  assert.ok(stored.url.endsWith('/hook/SECRETPATH'), "bob cannot repoint alice's channel");
  console.log('PASS: channel routes are user-scoped');

  // ------------------------------------------------------------ payload formats
  received.length = 0;
  r = await api('POST', `/channels/${aliceHook}/test`, alice, null, 'admin');
  assert.strictEqual(r.status, 200, r.text);
  let got = received.pop();
  assert.strictEqual(got.path, '/hook/SECRETPATH');
  assert.strictEqual(got.headers.authorization, 'Bearer SECRETTOKEN');
  assert.strictEqual(got.headers['content-type'], 'application/json');
  assert.strictEqual(got.body.source, 'bindarr');
  assert.strictEqual(got.body.event, 'test');
  assert.strictEqual(got.body.level, 'info');
  assert.ok(got.body.title && got.body.message && got.body.sent_at && got.body.data);

  r = await api('POST', `/channels/${aliceNtfy}/test`, alice, null, 'admin');
  assert.strictEqual(r.status, 200, r.text);
  got = received.pop();
  assert.strictEqual(got.path, '/', 'ntfy JSON publishes go to the server root');
  assert.strictEqual(got.headers.authorization, 'Bearer NTFYTOKEN');
  assert.strictEqual(got.body.topic, 'alice-cards');
  assert.ok(got.body.title && got.body.message);
  assert.strictEqual(typeof got.body.priority, 'number');
  assert.ok(Array.isArray(got.body.tags));

  const discordId = await addChannel(alice, 'discord', { events_price: 0, events_admin: 0 });
  r = await api('POST', `/channels/${discordId}/test`, alice, null, 'admin');
  assert.strictEqual(r.status, 200, r.text);
  got = received.pop();
  assert.strictEqual(got.body.username, 'Bindarr');
  assert.strictEqual(got.body.embeds.length, 1);
  assert.ok(got.body.embeds[0].title && got.body.embeds[0].description);
  assert.strictEqual(typeof got.body.embeds[0].color, 'number');
  assert.deepStrictEqual(got.body.allowed_mentions, { parse: [] }, 'card names must not ping anyone');
  assert.strictEqual(got.headers.authorization, undefined);

  const appriseId = await addChannel(alice, 'apprise', { events_price: 0, events_admin: 0 });
  r = await api('POST', `/channels/${appriseId}/test`, alice, null, 'admin');
  assert.strictEqual(r.status, 200, r.text);
  got = received.pop();
  assert.strictEqual(got.path, `/apprise/${alice}/SECRETPATH`);
  assert.deepStrictEqual(Object.keys(got.body).sort(), ['body', 'format', 'title', 'type']);
  assert.strictEqual(got.body.type, 'info');

  // Discord embed limits are respected.
  const long = payloads.buildRequest({ type: 'discord', url: 'https://discord.com/api/webhooks/1/x' },
    { type: 'x', level: 'failure', title: 't'.repeat(500), body: 'b'.repeat(5000) }).body;
  assert.ok(long.embeds[0].title.length <= 256 && long.embeds[0].description.length <= 4096);
  assert.strictEqual(long.embeds[0].color, 0xef4444);

  // A failed test says why, without the receiver's response body.
  responder = () => ({ status: 500, body: 'internal secret page' });
  r = await api('POST', `/channels/${aliceHook}/test`, alice, null, 'admin');
  assert.strictEqual(r.status, 502);
  assert.match(r.json.error, /HTTP 500/);
  assert.ok(!r.text.includes('internal secret page'), 'the response body must not be echoed');
  responder = () => ({ status: 204 });
  console.log('PASS: channel payload formats');

  // ---------------------------------------------------------- threshold logic
  const prefs = { price_pct: 15, price_abs: 5, min_price: 1 };
  assert.strictEqual(notify.isMove(10, 11, prefs), false, '10% and $1: neither bar');
  assert.strictEqual(notify.isMove(10, 12, prefs), true, '20% clears the percentage bar');
  assert.strictEqual(notify.isMove(10, 8, prefs), true, 'drops count as well as rises');
  assert.strictEqual(notify.isMove(100, 106, prefs), true, '$6 clears the absolute bar at 6%');
  assert.strictEqual(notify.isMove(100, 104, prefs), false, '$4 and 4%: neither');
  assert.strictEqual(notify.isMove(0.1, 0.5, prefs), false, 'a 400% move on a 50¢ card is under min_price');
  assert.strictEqual(notify.isMove(10, 11.5, prefs), false, 'exactly 15% is not MORE than 15%');
  assert.strictEqual(notify.isMove(10, 12, { price_pct: null, price_abs: 5, min_price: 1 }), false, 'a null bar is off');
  assert.strictEqual(notify.isMove(10, 16, { price_pct: 0, price_abs: 5, min_price: 1 }), true);
  assert.strictEqual(notify.isMove(10, 10, prefs), false);
  console.log('PASS: threshold logic');

  // ------------------------------------------------------ price moves + dedupe
  // Alice's webhook and ntfy listen for prices; bob's webhook too.
  await card('mtg-a', 'Black Lotus');
  await card('mtg-b', 'Llanowar Elves');
  await card('mtg-w', 'Wished Card');
  await card('mtg-bob', 'Bob Card');
  await own(alice, 'mtg-a');
  await own(alice, 'mtg-b');
  await own(alice, 'mtg-w', 'wishlist');
  await own(bob, 'mtg-bob');
  await price('mtg-a', 100);
  await price('mtg-b', 2);
  await price('mtg-w', 20);
  await price('mtg-bob', 10);

  received.length = 0;
  await notify.checkPriceMoves();
  await notify.flush();
  assert.strictEqual(received.length, 0, 'the first look only sets baselines');
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM notification_price_state WHERE user_id = ?`, [alice])).n, 3);

  await price('mtg-a', 130);   // +30%
  await price('mtg-b', 2.1);   // +5%, 10¢: neither
  await price('mtg-w', 30);    // wishlist +50%
  await notify.checkPriceMoves();
  await notify.flush();
  const aliceMsgs = received.filter(m => m.path === '/hook/SECRETPATH' || m.path === '/');
  assert.strictEqual(aliceMsgs.length, 2, "one digest to each of alice's two price channels");
  const digest = aliceMsgs.find(m => m.path === '/hook/SECRETPATH').body;
  assert.strictEqual(digest.event, 'price_moves');
  assert.deepStrictEqual(digest.data.moves.map(m => m.card_id).sort(), ['mtg-a', 'mtg-w']);
  assert.ok(digest.message.includes('Black Lotus') && digest.message.includes('(wishlist)'));
  assert.ok(!digest.message.includes('Llanowar'));
  assert.strictEqual(received.filter(m => m.path === '/bob').length, 0, "alice's moves never reach bob");

  // Dedupe: the same prices again, and a further move inside the cooldown, are
  // both silent.
  received.length = 0;
  await notify.checkPriceMoves();
  await price('mtg-a', 200);
  await notify.checkPriceMoves();
  await notify.flush();
  assert.strictEqual(received.length, 0, 'no repeat inside the cooldown window');
  // Once the cooldown has passed it is measured from the NOTIFIED price (130).
  await db.run(`UPDATE notification_price_state SET notified_at = ? WHERE user_id = ? AND card_id = 'mtg-a'`,
    [new Date(Date.now() - notify.PRICE_COOLDOWN_MS - 1000).toISOString(), alice]);
  await notify.checkPriceMoves();
  await notify.flush();
  const again = received.find(m => m.path === '/hook/SECRETPATH');
  assert.ok(again, 'notified again after the cooldown');
  assert.strictEqual(again.body.data.moves[0].old_price, 130);
  assert.strictEqual(again.body.data.moves[0].new_price, 200);

  // Bob's own card moves: only bob hears.
  received.length = 0;
  await price('mtg-bob', 20);
  await notify.checkPriceMoves();
  await notify.flush();
  assert.deepStrictEqual(received.map(m => m.path), ['/bob'], 'bob alone is told about his card');

  // Thresholds are per user: bob raises his bar, his next move stays quiet.
  r = await api('PUT', '/prefs', bob, { price_enabled: true, price_pct: 500, price_abs: null, min_price: 1, include_wishlist: true });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual((await api('GET', '/', bob)).json.prefs.price_pct, 500);
  await db.run(`UPDATE notification_price_state SET notified_at = NULL WHERE user_id = ?`, [bob]);
  received.length = 0;
  await price('mtg-bob', 40);
  await notify.checkPriceMoves();
  await notify.flush();
  assert.strictEqual(received.length, 0, "bob's 500% bar holds back a 100% move");
  r = await api('PUT', '/prefs', bob, { price_pct: -1, price_abs: 5, min_price: 1 });
  assert.strictEqual(r.status, 400);
  console.log('PASS: price moves, per-user thresholds and dedupe');

  // ------------------------------------------------------------- admin events
  received.length = 0;
  await db.run(`UPDATE notification_channels SET events_admin = 1 WHERE id = ?`, [bobHook]);   // forced in the DB
  notify.emit({ type: 'backup_failed', error: 'disk full' });
  notify.emit({ type: 'backup_failed', error: 'disk full' });
  await new Promise(r2 => setImmediate(r2));
  await new Promise(r2 => setTimeout(r2, 50));
  await notify.flush();
  const adminMsgs = received.filter(m => m.body && m.body.event === 'backup_failed' || (m.body && m.body.title === 'Backup failed'));
  assert.strictEqual(adminMsgs.length, 2, "one message to each of alice's admin channels, once");
  assert.ok(!received.some(m => m.path === '/bob'), 'a member never receives instance failures');
  // A different source is a different event.
  assert.strictEqual(await notify.notifyAdmins({ type: 'price_sweep_failed', source: 'scryfall', error: 'x' }), 2);
  assert.strictEqual(await notify.notifyAdmins({ type: 'price_sweep_failed', source: 'scryfall', error: 'x' }), 0, 'deduped');
  assert.strictEqual(await notify.notifyAdmins({ type: 'price_sweep_failed', source: 'lorcast', error: 'x' }), 2);
  assert.strictEqual(await notify.notifyAdmins({ type: 'catalog_build_failed', game: 'mtg', lang: 'English', error: 'x' }), 2);
  await notify.flush();
  // emit() is fire-and-forget: it returns at once and never throws.
  assert.strictEqual(notify.emit(undefined), undefined);
  assert.strictEqual(notify.emit({ type: 'no_such_event' }), undefined);
  console.log('PASS: admin events');

  // ------------------------------------------------- retries, backoff, Discord
  // A 500 stays pending with backoff; the retry then succeeds.
  await db.run(`DELETE FROM notification_log`);
  received.length = 0;
  responder = () => ({ status: 500 });
  await db.run(`UPDATE notification_channels SET events_admin = 0 WHERE user_id = ? AND id <> ?`, [alice, aliceHook]);
  await notify.notifyAdmins({ type: 'backup_failed', error: 'retry me' });
  await notify.flush();
  let row = (await logFor(alice))[0];
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.attempts, 1);
  assert.ok(row.next_attempt_at >= Date.now() + 20 * 1000, 'the first retry waits ~30s');
  responder = () => ({ status: 200 });
  await db.run(`UPDATE notification_log SET next_attempt_at = 0`);
  await notify.flush();
  row = (await logFor(alice))[0];
  assert.strictEqual(row.status, 'sent');
  assert.strictEqual(row.attempts, 2);

  // Gives up after MAX_ATTEMPTS.
  await db.run(`DELETE FROM notification_log`);
  responder = () => ({ status: 503 });
  await notify.notifyAdmins({ type: 'backup_failed', error: 'never' });
  for (let i = 0; i < notify.MAX_ATTEMPTS + 2; i++) {
    await db.run(`UPDATE notification_log SET next_attempt_at = 0 WHERE status = 'pending'`);
    await notify.flush();
  }
  row = (await logFor(alice))[0];
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.attempts, notify.MAX_ATTEMPTS);
  assert.strictEqual(await pending(), 0);

  // Discord 429: retry_after is honoured, and it does not use up an attempt.
  await db.run(`DELETE FROM notification_log`);
  await db.run(`UPDATE notification_channels SET events_admin = 1 WHERE id = ?`, [discordId]);
  await db.run(`UPDATE notification_channels SET events_admin = 0 WHERE id = ?`, [aliceHook]);
  let calls = 0;
  responder = () => (++calls === 1
    ? { status: 429, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry_after: 0.2, global: false }) }
    : { status: 204, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.3' } });
  await notify.notifyAdmins({ type: 'catalog_build_failed', game: 'pokemon', lang: 'German', error: 'boom' });
  await notify.flush();
  row = (await logFor(alice))[0];
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.attempts, 0, 'a 429 is not a failed attempt');
  assert.ok(row.next_attempt_at - Date.now() <= 300, 'retry_after (0.2s), not the 30s backoff');
  await new Promise(r2 => setTimeout(r2, 400));   // the queue's own timer delivers it
  await notify.flush();
  row = (await logFor(alice))[0];
  assert.strictEqual(row.status, 'sent');
  assert.ok(notify._blockedUntil.get(discordId) > Date.now(), 'Remaining: 0 pauses the channel pre-emptively');

  // A message for a deleted channel is dropped, not retried forever.
  await db.run(`INSERT INTO notification_log (user_id, channel_id, event_type, payload, next_attempt_at) VALUES (?, NULL, 'x', '{}', 0)`, [alice]);
  await notify.flush();
  assert.strictEqual(await pending(), 0);
  console.log('PASS: retries, backoff and Discord rate limits');

  // Deleting a channel is scoped and works.
  r = await api('DELETE', `/channels/${bobHook}`, bob);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await api('GET', '/', bob)).json.channels.length, 0);

  notify.stop();
  receiver.close();
  apiServer.close();
  console.log('All notification tests passed.');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    notify.stop();
    receiver.close();
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* gone */ }
    }
    process.exit(process.exitCode || 0);
  });
