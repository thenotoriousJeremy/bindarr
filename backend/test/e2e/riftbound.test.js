// End-to-end: Riftbound through a real server process, from the first search to
// an export and its re-import.
//
// RiftCodex is a local HTTP server serving test/fixtures/riftbound (the server is
// pointed at it with RIFTCODEX_BASE_URL), so nothing leaves the machine. TCGCSV is
// switched off by the e2e runner; prices have their own suite
// (test/riftboundprices.test.js). The ids are the point of several cases: the
// signature printing's id carries '.2a' (its riftbound_id has '*') and the Metal
// promo's carries '~', and both have to survive JSON bodies, Express path params,
// SQLite, a CSV export and the import that reads it back.
// Never let a test server sync TCGCSV (it has flagged this project for overuse).
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-riftbound-e2e-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3041';
const base = `http://localhost:${port}`;
const db = require('../../src/db');

const CARDS = require('../fixtures/riftbound/cards.json');
const SETS = require('../fixtures/riftbound/sets.json');
const SIG = 'riftbound-unl-229.2a-219';
const METAL = 'riftbound-opp-259-298~69bc5bf1d308c64675ca89f7';
const FIELD = 'riftbound-unl-215-219';

function startRiftcodex() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    const page = Number(url.searchParams.get('page')) || 1;
    const size = Math.min(100, Number(url.searchParams.get('size')) || 50);
    const source = url.pathname === '/cards' ? CARDS : url.pathname === '/sets' ? SETS.items : null;
    if (!source) { res.writeHead(404); return res.end('{}'); }
    const items = source.slice((page - 1) * size, page * size);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, total: source.length, page, size, pages: Math.ceil(source.length / size) }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits })));
}

async function waitFor(check, what) {
  for (let i = 0; i < 600; i++) {
    try { const v = await check(); if (v) return v; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${what} did not come up in time`);
}

let failures = 0;
async function tc(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name} - ${err.stack || err.message}`);
  }
}

async function main() {
  const { server: riftcodex, hits } = await startRiftcodex();
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-riftbound-models-'));
  const proc = spawn('node', [path.join(__dirname, '../../src/server.js')], {
    env: {
      ...process.env,
      PORT: port,
      DB_PATH: tmpDb,
      HTTPS_PORT: '',
      CV_MODEL_DIR: modelDir,
      RIFTCODEX_BASE_URL: `http://127.0.0.1:${riftcodex.address().port}`,
      RIFTCODEX_GAP_MS: '0',
      // Never sync TCGCSV from a test server, whoever runs this file.
      BINDARR_DISABLE_TCGCSV_SYNC: '1',
    },
  });
  let serverLog = '';
  let ok = false;
  proc.stdout.on('data', d => { serverLog += d; });
  proc.stderr.on('data', d => { serverLog += d; });

  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'server');
    ok = true;
    const admin = await waitFor(() => db.get(`SELECT id FROM users WHERE username = 'admin'`), 'admin user');
    const token = 'riftbound-e2e-token';
    await db.run(`INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
      [require('../../src/utils/authHelpers').hashSessionToken(token), admin.id]);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const api = async (method, url, body) => {
      const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* CSV and friends */ }
      return { status: res.status, json, text, headers: res.headers };
    };

    await tc('F9-TC1 startup asks RiftCodex for nothing', async () => {
      assert.deepStrictEqual(hits, [], `requests before first use: ${hits}`);
    });

    await tc('F9-TC2 the set list fetches the catalogue on first use', async () => {
      const r = await api('GET', '/api/sets?game=riftbound');
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.some(s => s.id === 'riftbound-unl' && s.ptcgo_code === 'UNL'), JSON.stringify(r.json));
      assert.ok(hits.includes('/cards') && hits.includes('/sets'));
    });

    await tc('F9-TC3 search by name, set browse, number and filters', async () => {
      const byName = await api('GET', '/api/search?game=riftbound&name=Piltover');
      assert.strictEqual(byName.status, 200);
      assert.ok(byName.json.some(c => c.id === SIG && c.number === '229*'));
      const browse = await api('GET', '/api/search?game=riftbound&set=UNL&limit=3');
      assert.strictEqual(browse.json.length, 3);
      assert.strictEqual(browse.headers.get('x-total-count'), '8', 'the whole set is counted for paging');
      const number = await api('GET', '/api/search?game=riftbound&set=UNL&number=229');
      assert.deepStrictEqual(number.json.map(c => c.id).sort(), ['riftbound-unl-229-219', SIG].sort());
      const fields = await api('GET', '/api/search?game=riftbound&type=Battlefield');
      assert.deepStrictEqual(fields.json.map(c => c.id), [FIELD]);
      assert.strictEqual(fields.json[0].orientation, 'landscape');
      const fury = await api('GET', '/api/search?game=riftbound&domain=Fury');
      assert.ok(fury.json.length > 0 && fury.json.every(c => c.types.includes('Fury')));
    });

    await tc('F9-TC4 an unknown game or id is refused, not sent to Pokémon', async () => {
      assert.strictEqual((await api('GET', '/api/search?game=yugioh&name=x')).status, 400);
      assert.strictEqual((await api('POST', '/api/collection', { card_id: 'not a card' })).status, 404);
    });

    let binder;
    await tc('F9-TC5 add to a binder: slot placement, the card\'s own game', async () => {
      binder = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [admin.id]);
      assert.ok(binder, 'the starter binder exists');
      for (const card_id of [SIG, METAL, FIELD]) {
        // The request says Pokémon on purpose: the card's game must win.
        const r = await api('POST', '/api/collection', { card_id, game: 'pokemon', printing: 'Holofoil', location_id: binder.id });
        assert.strictEqual(r.status, 200, `${card_id}: ${r.text}`);
      }
      const rows = await db.all(`SELECT card_id, game, compartment_id, position FROM collection WHERE user_id = ? ORDER BY id`, [admin.id]);
      assert.deepStrictEqual(rows.map(r => r.card_id), [SIG, METAL, FIELD]);
      assert.ok(rows.every(r => r.game === 'riftbound'), JSON.stringify(rows));
      assert.ok(rows.every(r => r.compartment_id && r.position >= 1000 && Number.isInteger(r.position / 1000)),
        `filed into binder slots at slot * 1000: ${JSON.stringify(rows)}`);
    });

    await tc('F9-TC6 the collection lists them, and ids survive a path param', async () => {
      const r = await api('GET', '/api/collection');
      const mine = r.json.filter(c => c.game === 'riftbound');
      assert.strictEqual(mine.length, 3);
      for (const id of [SIG, METAL]) {
        const p = await api('GET', `/api/cards/${encodeURIComponent(id)}/printing?lang=en`);
        assert.strictEqual(p.status, 200, `${id}: ${p.text}`);
        assert.strictEqual(p.json.id, id);
      }
    });

    await tc('F9-TC7 containers can be restricted to Riftbound', async () => {
      const r = await api('POST', '/api/locations', { name: 'Riftbound box', type: 'Box', game: 'riftbound' });
      assert.ok(r.status === 200 || r.status === 201, r.text);
    });

    await tc('F9-TC8 decks: Riftbound copy limits, and ids in path params', async () => {
      const d = await api('POST', '/api/decks', { name: 'Vi', game: 'riftbound', format: 'Constructed', target_size: 56 });
      assert.strictEqual(d.status, 201, d.text);
      const deckId = d.json.id;
      assert.strictEqual((await api('POST', `/api/decks/${deckId}/cards`, { card_id: SIG, quantity: 1 })).status, 200);
      assert.strictEqual((await api('POST', `/api/decks/${deckId}/cards`, { card_id: METAL, quantity: 1 })).status, 200);
      // A second copy of the Legend is refused (one owned; one Legend per deck).
      const second = await api('POST', `/api/decks/${deckId}/cards`, { card_id: SIG, quantity: 2 });
      assert.strictEqual(second.status, 400, second.text);
      assert.ok(/more than 1 copy|only own/.test(second.json.error), second.text);
      const del = await api('DELETE', `/api/decks/${deckId}/cards/${encodeURIComponent(METAL)}`);
      assert.strictEqual(del.status, 200);
      assert.strictEqual((await api('GET', `/api/decks/${deckId}`)).json.cards.length, 1, 'removed by its ~ id');
      assert.strictEqual((await api('POST', '/api/decks', { name: 'x', game: 'yugioh' })).status, 400);
    });

    await tc('F9-TC9 stats and net worth by game', async () => {
      const s = await api('GET', '/api/stats?game=riftbound');
      assert.strictEqual(s.status, 200);
      assert.strictEqual(s.json.summary.totalCards, 3, JSON.stringify(s.json).slice(0, 200));
      assert.strictEqual((await api('GET', '/api/stats?game=nope')).status, 400);
      const nw = await api('GET', '/api/stats/networth');
      assert.strictEqual(nw.json.byGame.riftbound.cards, 3);
    });

    await tc('F9-TC10 scanning says the catalog is not built', async () => {
      const r = await api('POST', '/api/scan-match', { game: 'riftbound', image: 'data:image/jpeg;base64,' + 'A'.repeat(400) });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.notBuilt, true);
    });

    let csv;
    await tc('F9-TC11 export carries the game and the ids', async () => {
      const r = await api('GET', '/api/export?format=csv');
      assert.strictEqual(r.status, 200);
      csv = r.text;
      const [header, ...lines] = csv.split('\n');
      assert.ok(header.startsWith('Card ID,Game'), header);
      for (const id of [SIG, METAL, FIELD]) assert.ok(lines.some(l => l.startsWith(`"${id}","riftbound"`)), `${id} in ${csv}`);
      const json = await api('GET', '/api/export?format=json');
      assert.ok(json.json.filter(r2 => r2.game === 'riftbound').length === 3);
    });

    await tc('F9-TC12 import reads its own export back', async () => {
      const before = (await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ? AND game = 'riftbound'`, [admin.id])).n;
      const r = await api('POST', '/api/import', { format: 'csv', data: csv });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.count, 3, r.text);
      const rows = await db.all(`SELECT card_id, game FROM collection WHERE user_id = ? ORDER BY id`, [admin.id]);
      assert.strictEqual(rows.length, before + 3);
      const imported = rows.slice(before);
      assert.deepStrictEqual(imported.map(x => x.card_id).sort(), [SIG, METAL, FIELD].sort());
      assert.ok(imported.every(x => x.game === 'riftbound'));
    });

    await tc('F9-TC13 a public share shows the cards', async () => {
      const share = await db.get(`SELECT share_token FROM users WHERE id = ?`, [admin.id]);
      await db.run(`UPDATE users SET share_enabled = 1 WHERE id = ?`, [admin.id]);
      const res = await fetch(`${base}/api/shared/${share.share_token}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      const cards = body.cards || body.collection || body;
      assert.ok(JSON.stringify(cards).includes(SIG), 'the signature printing is in the share');
    });
  } finally {
    proc.kill('SIGKILL');
    riftcodex.close();
    await new Promise(r => setTimeout(r, 300));
    if (failures || !ok) console.error(serverLog.split('\n').slice(-40).join('\n'));
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* gone */ } }
    try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  if (failures) {
    console.error(`${failures} Riftbound e2e case(s) failed.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
