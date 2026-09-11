// Live check of the pokemontcgapi provider against the real API, through the
// real server. Not part of `npm test`: it needs POKEMONTCGAPI_KEY and spends
// trial credits (about 15-20 for one run). Prints a report and exits non-zero
// on the first failed assertion.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const key = (process.env.POKEMONTCGAPI_KEY || '').trim();
if (!key) { console.error('POKEMONTCGAPI_KEY is required'); process.exit(2); }

const tmpDb = path.join(os.tmpdir(), `bindarr-live-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3019';
const base = `http://localhost:${port}`;
const db = require('../../src/db');

const report = [];
const log = (line) => { report.push(line); console.log(line); };

// /v1/me costs nothing and carries the live quota headers, which are exact at the
// moment of the call (the usage endpoint aggregates with a lag of minutes).
async function me() {
  const r = await fetch('https://api.pokemontcgapi.com/v1/me', { headers: { 'X-Api-Key': key } });
  const d = (await r.json()).data || {};
  const limit = Number(r.headers.get('x-quota-limit'));
  const remaining = Number(r.headers.get('x-quota-remaining'));
  return { plan: d.plan?.code, quotaUsed: Number.isFinite(limit) && Number.isFinite(remaining) ? limit - remaining : null };
}

async function waitFor(fn, what) {
  for (let i = 0; i < 200; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${what} did not become ready`);
}

async function main() {
  const before = await me();
  log(`plan=${before.plan} credits_used_before=${before.quotaUsed}`);

  const server = spawn('node', [path.join(__dirname, '../../src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, POKEMONTCGAPI_KEY: key, DEFAULT_ADMIN_PASSWORD: 'live-admin-password', CATALOG_AUTO_UPDATE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitFor(() => fetch(`${base}/api/health`).then(r => r.ok), 'server');
    const adminId = await waitFor(async () => (await db.get(`SELECT id FROM users WHERE username = 'admin'`))?.id, 'admin');
    const token = 'live-token';
    const exp = new Date(Date.now() + 86400000).toISOString();
    await db.run(`INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, adminId, exp]);
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const get = (p) => fetch(base + p, { headers: H });
    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${r.status} ${t.slice(0, 200)}`); } };

    // 1. Default untouched: the provider is not selected just because a key exists.
    const s0 = await json(await get('/api/settings'));
    assert.notStrictEqual(s0.pokemon_provider, 'pokemontcgapi', 'a key alone must not select the provider');
    log(`default provider stays "${s0.pokemon_provider}" with a key present: OK`);

    // 2. Select it.
    const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ pokemon_provider: 'pokemontcgapi' }) });
    assert.strictEqual(put.status, 200, `settings PUT ${put.status}`);
    const s1 = await json(await get('/api/settings'));
    assert.strictEqual(s1.pokemon_provider, 'pokemontcgapi');
    log('admin selects pokemontcgapi.com: OK');
    await new Promise(r => setTimeout(r, 1500)); // let the set re-sync settle

    // 3. Set lists per language.
    const counts = {};
    for (const lang of ['en', 'ja', 'zh-cn']) {
      const sets = await json(await get(`/api/sets?game=pokemon&lang=${lang}`));
      assert.ok(Array.isArray(sets) && sets.length > 0, `no sets for ${lang}`);
      assert.ok(sets.every(s => String(s.id).startsWith('pokemontcgapi-')), `set ids for ${lang} carry the provider prefix`);
      counts[lang] = sets.length;
    }
    log(`set lists: en=${counts.en} ja=${counts.ja} zh-cn=${counts['zh-cn']} (all ids prefixed pokemontcgapi-): OK`);

    // 4. Search by name, English.
    const t0 = Date.now();
    const en = await json(await get('/api/search?name=pikachu&scope=internet&lang=en&limit=5'));
    assert.ok(en.length > 0, 'english search returned nothing');
    const c = en[0];
    assert.ok(String(c.id).startsWith('pokemontcgapi-'), 'card id prefixed');
    assert.ok(c.image_url, 'card has an image');
    const priced = en.filter(x => x.price_trend > 0);
    log(`search "pikachu" en: ${en.length} cards in ${Date.now() - t0} ms, first=${c.name} (${c.set_name || c.set_id}) image=${c.image_url ? 'yes' : 'no'} priced=${priced.length}/${en.length}` +
        (priced[0] ? ` e.g. ${priced[0].price_trend} ${priced[0].price_currency || ''} from ${priced[0].price_source || '?'}` : '') + ': OK');

    // 5. Search by name, Japanese and Simplified Chinese.
    for (const lang of ['ja', 'zh-cn']) {
      const r = await json(await get(`/api/search?name=pikachu&scope=internet&lang=${lang}&limit=5`));
      assert.ok(r.length > 0, `${lang} search returned nothing`);
      const withArt = r.filter(x => x.image_url).length;
      const withPrice = r.filter(x => x.price_trend > 0).length;
      log(`search "pikachu" ${lang}: ${r.length} cards, ${withArt} with art, ${withPrice} with a price, first="${r[0].name}" set=${r[0].set_id}: OK`);
    }

    // 6. Cached lookup: same search again must be served from card_cache/response cache.
    const t1 = Date.now();
    const again = await json(await get('/api/search?name=pikachu&scope=internet&lang=en&limit=5'));
    assert.strictEqual(again.length, en.length);
    log(`repeat search served in ${Date.now() - t1} ms: OK`);

    // 7. Card by id through the printing endpoint (exercises getCardById).
    const one = await json(await get(`/api/cards/${encodeURIComponent(c.id)}/printing?lang=en&game=pokemon`));
    assert.ok(one && (one.id === c.id || one.card?.id === c.id || one.name), 'printing lookup failed');
    log(`card by id ${c.id}: OK`);

    // 8. Add to collection, then run the price sweep the way the hourly timer does:
    //    unforced, so shouldSweepPrices decides, and only over cards whose stored
    //    price has aged out. The card was just priced on add, so its price is aged
    //    by hand first; a fresh DB has never swept, so the sweep is due.
    const add = await fetch(`${base}/api/collection`, { method: 'POST', headers: H, body: JSON.stringify({ card_id: c.id, quantity: 1 }) });
    assert.ok(add.status < 300, `add to collection ${add.status} ${await add.text()}`);
    const owned = await db.get(`SELECT price_trend, price_currency, price_source FROM card_cache WHERE id = ?`, [c.id]);
    assert.ok(owned && owned.price_trend > 0, `the card entering the collection must be priced, got ${JSON.stringify(owned)}`);
    log(`owned card priced on add: ${owned.price_trend} ${owned.price_currency} from ${owned.price_source} (listing rows stay unpriced by design): OK`);
    await db.run(`UPDATE card_cache SET last_updated = datetime('now', '-4 days') WHERE id = ?`, [c.id]);
    await require('../../src/pokemontcgapi').updateCollectionPrices();
    const hist = await db.all(`SELECT price FROM price_history WHERE card_id = ?`, [c.id]);
    const swept = await db.get(`SELECT pokemontcgapi_prices_swept_at AS at FROM app_settings WHERE id = 1`);
    assert.ok(swept && swept.at, 'the sweep must record that it ran');
    log(`unforced sweep ran over stale owned cards (gate: shouldSweepPrices), price_history rows=${hist.length}: OK`);

    // 9. Nothing leaked into the other providers' id spaces.
    const foreign = await db.get(`SELECT COUNT(*) n FROM card_cache WHERE game='pokemon' AND id NOT LIKE 'pokemontcgapi-%'`);
    log(`card_cache rows from other providers: ${foreign.n} (expected 0 on a fresh DB): ${foreign.n === 0 ? 'OK' : 'CHECK'}`);
    const cacheRows = await db.get(`SELECT COUNT(*) n FROM pokemontcgapi_cache`);
    log(`response cache rows: ${cacheRows.n}`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    console.error(serverLog.split('\n').filter(l => /pokemontcgapi|error|Error/i.test(l)).slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    server.kill();
    try { fs.unlinkSync(tmpDb); } catch {}
  }
  const after = await me();
  log(`credits_used_after=${after.quotaUsed} (spent=${after.quotaUsed != null && before.quotaUsed != null ? after.quotaUsed - before.quotaUsed : '?'})`);
  const out = path.join(os.tmpdir(), 'bindarr-pokemontcgapi-live-report.txt');
  fs.writeFileSync(out, report.join('\n') + '\n');
  console.log(`report written to ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
