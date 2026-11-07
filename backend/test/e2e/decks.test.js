// Each server this suite starts gets a fresh database, which would otherwise run a
// full TCGCSV sync (~800 requests) at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

// Deck formats, any-printing decks and checkout allocation over real HTTP, against
// a real server and a throwaway database. The race at the top is the point: two
// checkouts fired at once for the same copies must not both get them.
const tmpDb = path.join(os.tmpdir(), `bindarr-decks-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3017';
const base = `http://localhost:${port}`;

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');
const { hashSessionToken } = require('../../src/utils/authHelpers');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function runCase(id, fn) {
  try {
    await fn();
    console.log(`PASS: ${id}`);
  } catch (err) {
    console.error(`FAIL: ${id} -`, err.message);
    throw err;
  }
}

async function runTests() {
  // The mock keeps any Scryfall call this server makes (a startup price sweep)
  // off the network.
  const server = spawn('node', ['-r', path.join(__dirname, 'scryfall-mock.js'), path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });

  try {
    await waitForServer();
    const adminId = await waitForAdmin();
    const token = crypto.randomBytes(24).toString('hex');
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [hashSessionToken(token), adminId, new Date(Date.now() + 86400000).toISOString()]);
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    const api = async (method, url, body) => {
      const res = await fetch(`${base}/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const cache = (id, name, game, extra = {}) => db.run(
      `INSERT INTO card_cache (id, name, game, supertype, subtypes, color_identity, oracle_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, game, extra.supertype || 'MTG', JSON.stringify(extra.subtypes || []), JSON.stringify(extra.identity || []), extra.oracle || null]
    );
    const own = async (cardId, game, copies) => {
      const ids = [];
      for (let i = 0; i < copies; i++) {
        ids.push((await db.run(`INSERT INTO collection (card_id, quantity, game, user_id) VALUES (?, 1, ?, ?)`, [cardId, game, adminId])).lastID);
      }
      return ids;
    };
    const newDeck = async (name, game, format, cards, extra = {}) => {
      const created = await api('POST', '/decks', { name, game, format, ...extra });
      assert.strictEqual(created.status, 201, `create ${name}: ${JSON.stringify(created.body)}`);
      for (const [card_id, quantity] of cards) {
        const added = await api('POST', `/decks/${created.body.id}/cards`, { card_id, quantity });
        assert.strictEqual(added.status, 200, `add ${card_id} to ${name}: ${JSON.stringify(added.body)}`);
      }
      return created.body.id;
    };
    const holdings = (deckId) => db.all(`SELECT entry_id FROM deck_allocations WHERE deck_id = ? ORDER BY entry_id`, [deckId]);

    await cache('mtg-counterspell', 'Counterspell', 'mtg', { subtypes: ['Instant'], identity: ['Blue'], oracle: 'o-counterspell' });
    const counterspells = await own('mtg-counterspell', 'mtg', 2);

    // F9-TC1: two checkouts fired at once for the same two copies. Exactly one deck
    // gets them; the other is refused cleanly, holds nothing and stays in storage.
    // Raced several times, returning the winner in between, to vary the interleaving.
    await runCase('F9-TC1', async () => {
      const left = await newDeck('Left', 'mtg', 'Modern', [['mtg-counterspell', 2]]);
      const right = await newDeck('Right', 'mtg', 'Modern', [['mtg-counterspell', 2]]);
      for (let round = 0; round < 5; round++) {
        const [a, b] = await Promise.all([
          api('PUT', `/decks/${left}/checkout`),
          api('PUT', `/decks/${right}/checkout`),
        ]);
        const statuses = [a.status, b.status];
        assert.strictEqual(statuses.filter(s => s === 200).length, 1, `round ${round}: exactly one checkout wins, got ${statuses}`);
        const loser = a.status === 200 ? b : a;
        assert.ok([400, 409].includes(loser.status), `round ${round}: the other is refused, got ${loser.status}`);
        const [winnerId, loserId] = a.status === 200 ? [left, right] : [right, left];

        assert.deepStrictEqual((await holdings(winnerId)).map(h => h.entry_id), counterspells, 'the winner holds both copies');
        assert.deepStrictEqual(await holdings(loserId), [], 'the loser holds none');
        const twice = await db.all(`SELECT entry_id FROM deck_allocations GROUP BY entry_id HAVING COUNT(*) > 1`);
        assert.deepStrictEqual(twice, [], 'no copy is allocated twice');
        const out = await db.all(`SELECT id FROM decks WHERE id IN (?, ?) AND checked_out = 1`, [left, right]);
        assert.deepStrictEqual(out.map(d => d.id), [winnerId], 'only the winner is checked out');

        const returned = await api('PUT', `/decks/${winnerId}/return`);
        assert.strictEqual(returned.status, 200);
        assert.deepStrictEqual(await holdings(winnerId), []);
      }
    });

    // F9-TC2: a crowd. Four one-card decks race for two copies; two win.
    await runCase('F9-TC2', async () => {
      const decks = [];
      for (let i = 0; i < 4; i++) decks.push(await newDeck(`Crowd ${i}`, 'mtg', 'Modern', [['mtg-counterspell', 1]]));
      const results = await Promise.all(decks.map(id => api('PUT', `/decks/${id}/checkout`)));
      assert.strictEqual(results.filter(r => r.status === 200).length, 2, `two of four win: ${results.map(r => r.status)}`);
      assert.ok(results.every(r => [200, 400, 409].includes(r.status)));
      const allocated = await db.all(`SELECT entry_id, deck_id FROM deck_allocations ORDER BY entry_id`);
      assert.deepStrictEqual(allocated.map(a => a.entry_id), counterspells, 'each copy exactly once');
      for (const id of decks) await api('PUT', `/decks/${id}/return`);
    });

    // F9-TC3: the copy limit follows the format. Commander is singleton by name across
    // printings; Modern allows four; basic lands are free in both.
    await runCase('F9-TC3', async () => {
      await cache('mtg-ring-cmr', 'Sol Ring', 'mtg', { subtypes: ['Artifact'], oracle: 'o-ring' });
      await cache('mtg-ring-c21', 'Sol Ring', 'mtg', { subtypes: ['Artifact'], oracle: 'o-ring' });
      await cache('mtg-forest', 'Forest', 'mtg', { subtypes: ['Basic', 'Land', 'Forest'], identity: ['Green'] });
      await cache('mtg-pool', 'Breeding Pool', 'mtg', { subtypes: ['Land', 'Forest', 'Island'], identity: ['Green', 'Blue'] });
      await own('mtg-ring-cmr', 'mtg', 4);
      await own('mtg-ring-c21', 'mtg', 1);
      await own('mtg-forest', 'mtg', 30);
      await own('mtg-pool', 'mtg', 2);

      const edh = await newDeck('Singleton', 'mtg', 'Commander / EDH', [['mtg-ring-cmr', 1], ['mtg-forest', 30]]);
      const again = await api('POST', `/decks/${edh}/cards`, { card_id: 'mtg-ring-c21', quantity: 1 });
      assert.strictEqual(again.status, 400);
      assert.match(again.body.error, /more than 1 copy of Sol Ring/);
      const pools = await api('POST', `/decks/${edh}/cards`, { card_id: 'mtg-pool', quantity: 2 });
      assert.strictEqual(pools.status, 400, 'a shockland is not a basic land');

      const modern = await newDeck('Four-of', 'mtg', 'Modern', [['mtg-ring-cmr', 4], ['mtg-pool', 2]]);
      const fifth = await api('POST', `/decks/${modern}/cards`, { card_id: 'mtg-ring-c21', quantity: 1 });
      assert.strictEqual(fifth.status, 400);
      assert.match(fifth.body.error, /more than 4 copies/);
    });

    // F9-TC4: any printing. Magic decks accept it by default and count the other
    // printing as owned; Pokémon decks never do, even when asked.
    await runCase('F9-TC4', async () => {
      // The C21 copy is the only one; the deck lists the CMR printing.
      await cache('mtg-ponder-a', 'Ponder', 'mtg', { subtypes: ['Sorcery'], oracle: 'o-ponder' });
      await cache('mtg-ponder-b', 'Ponder', 'mtg', { subtypes: ['Sorcery'], oracle: 'o-ponder' });
      const [ponder] = await own('mtg-ponder-b', 'mtg', 1);
      // Not a copy of the listed printing in sight, yet the add passes the owned-copy
      // check: this deck counts the other one.
      const anyDeck = await newDeck('Any', 'mtg', 'Modern', [['mtg-ponder-a', 1]]);

      const detail = await api('GET', `/decks/${anyDeck}`);
      assert.strictEqual(detail.body.any_printing, 1, 'on by default for Magic');
      const card = detail.body.cards.find(c => c.id === 'mtg-ponder-a');
      assert.deepStrictEqual([card.owned_qty, card.missing_qty], [1, 0], 'the other printing counts as owned');
      const pull = await api('GET', `/decks/${anyDeck}/locations`);
      assert.deepStrictEqual(pull.body[0].locations.map(l => [l.entry_id, l.substitute]), [[ponder, true]]);

      const off = await api('PUT', `/decks/${anyDeck}`, { name: 'Any', any_printing: false });
      assert.strictEqual(off.status, 200);
      const exactly = (await api('GET', `/decks/${anyDeck}`)).body.cards.find(c => c.id === 'mtg-ponder-a');
      assert.deepStrictEqual([exactly.owned_qty, exactly.missing_qty], [0, 1], 'switched off, it is missing');

      const pokemon = await api('POST', '/decks', { name: 'Pika', game: 'pokemon', format: 'Standard', any_printing: true });
      const pikaDeck = (await api('GET', `/decks/${pokemon.body.id}`)).body;
      assert.strictEqual(pikaDeck.any_printing, 0, 'Pokémon decks are always exact');
    });

    // F9-TC5: commanders are marked per card and come back with the card text the
    // deck builder's rules read.
    await runCase('F9-TC5', async () => {
      await cache('mtg-krenko', 'Krenko, Mob Boss', 'mtg', { subtypes: ['Legendary', 'Creature', 'Goblin', 'Warrior'], identity: ['Red'], oracle: 'o-krenko' });
      await own('mtg-krenko', 'mtg', 1);
      const edh = await newDeck('Goblins', 'mtg', 'Commander / EDH', [['mtg-krenko', 1]]);
      const marked = await api('PUT', `/decks/${edh}/cards/mtg-krenko/commander`, { commander: true });
      assert.strictEqual(marked.status, 200);
      const krenko = (await api('GET', `/decks/${edh}`)).body.cards.find(c => c.id === 'mtg-krenko');
      assert.strictEqual(krenko.is_commander, 1);
      assert.deepStrictEqual(krenko.color_identity, ['Red']);
      assert.ok('oracle_text' in krenko && 'oracle_id' in krenko);
      const missing = await api('PUT', `/decks/${edh}/cards/mtg-ring-cmr/commander`, { commander: true });
      assert.strictEqual(missing.status, 404, 'only a card in the deck can lead it');
    });

    // F9-TC6: a checked-out deck's pull list is exactly what it holds, and storage
    // greys out exactly those copies. A card added while it is out takes a free copy.
    await runCase('F9-TC6', async () => {
      await cache('mtg-brainstorm', 'Brainstorm', 'mtg', { subtypes: ['Instant'], oracle: 'o-brainstorm' });
      const storms = await own('mtg-brainstorm', 'mtg', 3);
      const deckId = await newDeck('Storm', 'mtg', 'Modern', [['mtg-brainstorm', 2]]);
      assert.strictEqual((await api('PUT', `/decks/${deckId}/checkout`)).status, 200);
      const heldIds = (await holdings(deckId)).map(h => h.entry_id);
      assert.strictEqual(heldIds.length, 2);

      const pull = await api('GET', `/decks/${deckId}/locations`);
      assert.deepStrictEqual(pull.body[0].locations.map(l => l.entry_id).sort((x, y) => x - y), heldIds);
      const collection = (await api('GET', '/collection')).body;
      const greyed = collection.filter(e => e.checked_out_qty > 0).map(e => e.entry_id).sort((x, y) => x - y);
      assert.deepStrictEqual(greyed, heldIds);

      const more = await api('POST', `/decks/${deckId}/cards`, { card_id: 'mtg-brainstorm', quantity: 3 });
      assert.strictEqual(more.status, 200);
      assert.deepStrictEqual((await holdings(deckId)).map(h => h.entry_id), storms, 'the third copy joins it');
      const detail = (await api('GET', `/decks/${deckId}`)).body.cards[0];
      assert.deepStrictEqual([detail.allocated_qty, detail.missing_qty], [3, 0]);

      const deleted = await api('DELETE', `/decks/${deckId}`);
      assert.strictEqual(deleted.status, 200);
      assert.deepStrictEqual(await holdings(deckId), [], 'deleting a deck releases its copies');
    });

    // F9-TC7: a deck card's quantity is a whole number from 1 to 999. A fraction is
    // refused rather than rounded, and 0 is not a delete (DELETE is); nothing is
    // written either way.
    await runCase('F9-TC7', async () => {
      const deckId = (await api('POST', '/decks', { name: 'Counts', game: 'mtg', format: 'Modern' })).body.id;
      const rows = () => db.all(`SELECT quantity FROM deck_cards WHERE deck_id = ?`, [deckId]);
      for (const quantity of [2.5, '2.5', 0, '0', -1, 1000, 'two', true, null, '1e1']) {
        const res = await api('POST', `/decks/${deckId}/cards`, { card_id: 'mtg-counterspell', quantity });
        assert.strictEqual(res.status, 400, `quantity ${JSON.stringify(quantity)} must be refused`);
        assert.match(res.body.error, /whole number from 1 to 999/);
        assert.deepStrictEqual(await rows(), [], `quantity ${JSON.stringify(quantity)} wrote nothing`);
      }
      assert.strictEqual((await api('POST', `/decks/${deckId}/cards`, { card_id: 'mtg-counterspell' })).status, 200, 'omitted means one');
      assert.deepStrictEqual(await rows(), [{ quantity: 1 }]);
      assert.strictEqual((await api('POST', `/decks/${deckId}/cards`, { card_id: 'mtg-counterspell', quantity: '2' })).status, 200, 'a whole number as text');
      assert.deepStrictEqual(await rows(), [{ quantity: 2 }]);
    });
  } finally {
    // SIGKILL immediately to avoid sqlite3 teardown crashes on Windows
    server.kill('SIGKILL');
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: decks.test.js -', err.message); setTimeout(() => process.exit(1), 500); });
