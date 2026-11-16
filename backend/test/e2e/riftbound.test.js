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
//
// The sets RiftCodex lacks (riftboundTcgplayer.js, #181) come from TCGplayer's
// category 89 in the TCGCSV cache, which is written into the database before the
// server starts (test/fixtures/riftbound/tcgplayer-89.json: Radiance, which
// RiftCodex does not have). Then RiftCodex "adds" Radiance and the server restarts
// into its weekly refresh: the same ids, RiftCodex's rows, held cards kept.
// Never let a test server sync TCGCSV (it has flagged this project for overuse).
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
const assert = require('assert');
const http = require('http');
const harness = require('./harness');

const tmp = harness.tempDatabase('riftbound-e2e');
let base;
const db = require('../../src/db');

const CARDS = require('../fixtures/riftbound/cards.json');
const SETS = require('../fixtures/riftbound/sets.json');
const TCGPLAYER = require('../fixtures/riftbound/tcgplayer-89.json');
const LATER = require('../fixtures/riftbound/riftcodex-later.json');
const SIG = 'riftbound-unl-229.2a-219';
const METAL = 'riftbound-opp-259-298~69bc5bf1d308c64675ca89f7';
const FIELD = 'riftbound-unl-215-219';
// Radiance, from TCGplayer: ids in RiftCodex's shape, worked out from TCGplayer's numbers.
const RAD = {
  ekkoAlt: 'riftbound-rad-061a-167',          // 061a/167
  jarvan: 'riftbound-rad-179.2a-167',         // 179*/167
  aphelios: 'riftbound-rad-179.2a-167~tcgp724664', // the same number again
  kaisa: 'riftbound-rad-sp4-005',             // SP4/005
  token: 'riftbound-rad-tcgp728142',          // 'T02 // T05': no RiftCodex shape
};

// What the fake RiftCodex serves; the restart below adds Radiance.
const served = { cards: CARDS, sets: SETS.items };

// TCGCSV's category 89 as the daily sync would leave it.
async function seedTcgcsv() {
  const version = '2026-11-16T20:05:50+0000';
  await db.run(`UPDATE app_settings SET tcgcsv_data_version = ?, tcgcsv_last_checked_at = CURRENT_TIMESTAMP WHERE id = 1`, [version]);
  const put = (p, rows) => db.run(
    `INSERT OR REPLACE INTO tcgcsv_cache (path, data_version, results_json) VALUES (?, ?, ?)`, [p, version, JSON.stringify(rows)]
  );
  await put('/tcgplayer/89/groups', TCGPLAYER.groups);
  for (const g of TCGPLAYER.groups) {
    await put(`/tcgplayer/89/${g.groupId}/products`, TCGPLAYER.products[g.groupId] || []);
    await put(`/tcgplayer/89/${g.groupId}/prices`, TCGPLAYER.prices[g.groupId] || []);
  }
}

function startRiftcodex() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    const page = Number(url.searchParams.get('page')) || 1;
    const size = Math.min(100, Number(url.searchParams.get('size')) || 50);
    const source = url.pathname === '/cards' ? served.cards : url.pathname === '/sets' ? served.sets : null;
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
  // The admin and its session go into the file before the server opens it.
  await harness.prepare(db);
  const admin = await waitFor(() => db.get(`SELECT id FROM users WHERE username = 'admin'`), 'admin user');
  const token = 'riftbound-e2e-token';
  await db.run(`INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
    [require('../../src/utils/authHelpers').hashSessionToken(token), admin.id]);
  await seedTcgcsv();

  const { server: riftcodex, hits } = await startRiftcodex();
  let proc;
  let ok = false;
  // The harness's empty model directory, and TCGCSV off, as for every suite.
  const env = {
    RIFTCODEX_BASE_URL: `http://127.0.0.1:${riftcodex.address().port}`,
    RIFTCODEX_GAP_MS: '0',
  };

  try {
    proc = await harness.startServer(tmp, { env });
    base = proc.base;
    ok = true;
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
      // In Unleashed: the Worlds Bundle's battlefields, from TCGplayer, are F9-TC15's.
      const fields = await api('GET', '/api/search?game=riftbound&set=UNL&type=Battlefield');
      assert.deepStrictEqual(fields.json.map(c => c.id), [FIELD]);
      assert.strictEqual(fields.json[0].orientation, 'landscape');
      const fury = await api('GET', '/api/search?game=riftbound&domain=Fury');
      assert.ok(fury.json.length > 0 && fury.json.every(c => c.types.includes('Fury')));
    });

    await tc('F9-TC4 an unknown game or id is refused, not sent to Pokémon', async () => {
      assert.strictEqual((await api('GET', '/api/search?game=notagame&name=x')).status, 400);
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
      assert.strictEqual((await api('POST', '/api/decks', { name: 'x', game: 'notagame' })).status, 400);
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
      const enabled = await api('PUT', '/api/auth/settings', { share_enabled: true });
      assert.strictEqual(enabled.status, 200, enabled.text);
      const res = await fetch(`${base}/api/shared/${share.share_token}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      const cards = body.cards || body.collection || body;
      assert.ok(JSON.stringify(cards).includes(SIG), 'the signature printing is in the share');
    });

    // --- #181: a set RiftCodex lacks, from TCGplayer ---------------------------------

    await tc('F9-TC14 a set RiftCodex lacks is in the set list', async () => {
      const r = await api('GET', '/api/sets?game=riftbound');
      const rad = r.json.find(s => s.id === 'riftbound-rad');
      assert.ok(rad, JSON.stringify(r.json.map(s => s.id)));
      assert.deepStrictEqual([rad.name, rad.ptcgo_code, rad.release_date], ['Radiance', 'RAD', '2026-10-23']);
      assert.ok(!r.json.some(s => s.id === 'riftbound-lgc'), 'a group of sealed product only is no set');
      assert.ok(!hits.some(h => h !== '/cards' && h !== '/sets'), `RiftCodex asked for nothing else: ${hits}`);
    });

    await tc('F9-TC15 its cards are searchable, browsable and priced', async () => {
      const browse = await api('GET', '/api/search?game=riftbound&set=RAD');
      assert.strictEqual(browse.status, 200, browse.text);
      assert.strictEqual(browse.headers.get('x-total-count'), '8', 'eight cards; the booster pack is not one');
      const ids = browse.json.map(c => c.id);
      for (const id of Object.values(RAD)) assert.ok(ids.includes(id), `${id} in ${ids}`);
      const alt = browse.json.find(c => c.id === RAD.ekkoAlt);
      assert.deepStrictEqual([alt.name, alt.number, alt.rarity, alt.set_name], ['Ekko, Ingenious (Alternate Art)', '061a', 'Showcase', 'Radiance']);
      assert.strictEqual(alt.price_trend, 0.99, 'TCGplayer\'s price');
      assert.strictEqual(alt.price_holofoil, 0.99, 'a Foil listing');
      const byName = await api('GET', '/api/search?game=riftbound&name=Jarvan');
      assert.deepStrictEqual(byName.json.map(c => c.id), [RAD.jarvan]);
      // What a card is comes from TCGplayer too: the filters and deck rules read it.
      const legends = await api('GET', '/api/search?game=riftbound&set=RAD&type=Legend');
      assert.deepStrictEqual(legends.json.map(c => c.id), [RAD.jarvan]);
      assert.deepStrictEqual(alt.types, ['Mind']);
      const fields = await api('GET', '/api/search?game=riftbound&set=RWB&type=Battlefield');
      assert.ok(fields.json.length && fields.json.every(c => c.orientation === 'landscape'), JSON.stringify(fields.json));
      // RiftCodex's own sets are not doubled.
      const unl = await api('GET', '/api/search?game=riftbound&set=UNL');
      assert.strictEqual(unl.headers.get('x-total-count'), '8');
    });

    await tc('F9-TC16 fetched by id, ~ and .2a in a path param included', async () => {
      for (const id of [RAD.aphelios, RAD.jarvan, RAD.token]) {
        const p = await api('GET', `/api/cards/${encodeURIComponent(id)}/printing?lang=en`);
        assert.strictEqual(p.status, 200, `${id}: ${p.text}`);
        assert.strictEqual(p.json.id, id);
      }
    });

    await tc('F9-TC17 owned, and the set completes', async () => {
      binder = binder || await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [admin.id]);
      for (const card_id of [RAD.ekkoAlt, RAD.kaisa]) {
        const r = await api('POST', '/api/collection', { card_id, printing: 'Holofoil', location_id: binder.id });
        assert.strictEqual(r.status, 200, `${card_id}: ${r.text}`);
      }
      const rows = await db.all(`SELECT card_id, game FROM collection WHERE user_id = ? AND card_id LIKE 'riftbound-rad-%'`, [admin.id]);
      assert.deepStrictEqual(rows.map(r => r.game), ['riftbound', 'riftbound']);
      const done = await api('GET', '/api/set-completion?set=riftbound-rad&game=riftbound');
      assert.strictEqual(done.status, 200, done.text);
      assert.strictEqual(done.json.cards.length, 8);
      assert.strictEqual(done.json.set.tcgplayer_set_code, 'RAD');
      assert.strictEqual(done.json.cards.filter(c => c.owned > 0).length, 2);
    });

    await tc('F9-TC18 RiftCodex adds the set: the same ids, its rows, held cards kept', async () => {
      await proc.stop();
      // Its weekly refresh, due at the next boot; the file is written while no server has it.
      await db.run(`DELETE FROM job_runs WHERE name = 'sets-refresh'`);
      served.cards = [...CARDS, ...LATER.RAD];
      served.sets = [...SETS.items, LATER.RAD_SET];
      hits.length = 0;
      proc = await harness.startServer(tmp, { env });
      base = proc.base;
      const printing = (id) => api('GET', `/api/cards/${encodeURIComponent(id)}/printing?lang=en`);
      await waitFor(async () => hits.includes('/cards') && (await printing(RAD.ekkoAlt)).json.supertype === 'Unit', 'the RiftCodex refresh');
      const alt = (await printing(RAD.ekkoAlt)).json;
      assert.strictEqual(alt.name, 'Ekko - Ingenious (Alternate Art)', 'RiftCodex\'s card, on the id the collection holds');
      assert.deepStrictEqual(Array.isArray(alt.types) ? alt.types : JSON.parse(alt.types), ['Mind'], 'with its domain');
      const mine = await api('GET', '/api/collection');
      const held = mine.json.filter(c => String(c.card_id).startsWith('riftbound-rad-')).map(c => c.card_id).sort();
      assert.deepStrictEqual(held, [RAD.ekkoAlt, RAD.kaisa].sort(), 'both copies still in the collection');
      assert.strictEqual((await printing(RAD.kaisa)).json.name, "Kai'Sa, Rebel (K/DA Special Art Card)", 'RiftCodex lacks it; held, so kept');
      assert.strictEqual((await printing(RAD.token)).status, 404, 'nobody held it: gone');
      const browse = await api('GET', '/api/search?game=riftbound&set=RAD');
      const ids = browse.json.map(c => c.id);
      assert.ok(ids.includes(RAD.jarvan) && !ids.includes(RAD.aphelios), ids.join(','));
      const sets = await api('GET', '/api/sets?game=riftbound');
      assert.strictEqual(sets.json.find(s => s.id === 'riftbound-rad').series, 'Riftbound', 'the set is RiftCodex\'s');
    });
  } finally {
    // A server that never came up is in startServer's error, log and all.
    if (proc) {
      await proc.stop();
      if (failures || !ok) console.error(proc.tail(40));
    }
    riftcodex.close();
    await harness.cleanup(db, tmp);
  }
  if (failures) {
    console.error(`${failures} Riftbound e2e case(s) failed.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
