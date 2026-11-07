// The connection lock in db.js. The process shares ONE sqlite3 connection, so an
// open transaction used to swallow every other request's statements: their
// writes landed inside it and were undone by its ROLLBACK, and their reads saw
// rows nobody had committed. Each case below fails against the old
// BEGIN-on-the-shared-connection withTransaction.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const sqlite3 = require('sqlite3');

const tmpDb = path.join(os.tmpdir(), `bindarr-dbtx-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;

const db = require('../src/db');

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

// A promise the test opens by hand, to hold a transaction open at a known point.
function gate() {
  let open;
  const wait = new Promise(resolve => { open = resolve; });
  return { wait, open };
}

// Fails instead of hanging when the lock deadlocks.
async function within(ms, promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish (deadlock?)`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const names = async () => (await db.all(`SELECT name FROM t ORDER BY name`)).map(r => r.name);
const reset = () => db.run(`DELETE FROM t`);

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await db.run(`CREATE TABLE t (name TEXT PRIMARY KEY)`);
  await db.run(`CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
  await db.run(`INSERT INTO counter (id, n) VALUES (1, 0)`);

  // --- an outside write survives a rollback, and no one reads uncommitted rows --
  {
    const entered = gate();
    const held = gate();
    const tx = db.withTransaction(async () => {
      await db.run(`INSERT INTO t (name) VALUES ('inside')`);
      entered.open();
      await held.wait;
      throw new Error('boom');
    });
    await entered.wait;

    let wrote = false;
    let seen = null;
    const write = db.run(`INSERT INTO t (name) VALUES ('outside')`).then(() => { wrote = true; });
    const read = db.get(`SELECT COUNT(*) AS n FROM t WHERE name = 'inside'`).then(r => { seen = r.n; });
    await tick(60);
    assert.strictEqual(wrote, false, 'an outside write waits while a transaction is open');
    assert.strictEqual(seen, null, 'so does an outside read');

    held.open();
    await assert.rejects(tx, /boom/);
    await write;
    await read;
    assert.strictEqual(seen, 0, 'the outside read never saw the row that was rolled back');
    assert.deepStrictEqual(await names(), ['outside'], "the rollback undid the transaction's own write and nothing else");
  }

  // --- helpers the callback awaits are inside it, however deep --------------------
  await reset();
  {
    const helper = async (name) => {
      await tick(5);                                   // a timer hop
      const { n } = await db.get(`SELECT COUNT(*) AS n FROM t`);
      await db.run(`INSERT INTO t (name) VALUES (?)`, [name]);
      return n;
    };
    const seenInside = await within(3000, db.withTransaction(async () => {
      const first = await helper('helper');
      // A helper that opens its own transaction joins this one as a savepoint.
      const second = await db.withTransaction(() => helper('nested'));
      return [first, second];
    }), 'a transaction calling helpers');
    assert.deepStrictEqual(seenInside, [0, 1], 'the nested helper saw the outer write: same transaction');
    assert.deepStrictEqual(await names(), ['helper', 'nested']);
  }

  // --- a failed nested transaction undoes only its own writes ---------------------
  await reset();
  {
    await db.withTransaction(async () => {
      await db.run(`INSERT INTO t (name) VALUES ('before')`);
      await assert.rejects(db.withTransaction(async () => {
        await db.run(`INSERT INTO t (name) VALUES ('undone')`);
        throw new Error('inner');
      }), /inner/);
      await db.run(`INSERT INTO t (name) VALUES ('after')`);
    });
    assert.deepStrictEqual(await names(), ['after', 'before'], 'the caller caught the inner failure and kept its own work');

    await assert.rejects(db.withTransaction(async () => {
      await db.withTransaction(() => db.run(`INSERT INTO t (name) VALUES ('nested-ok')`));
      throw new Error('outer');
    }), /outer/);
    assert.ok(!(await names()).includes('nested-ok'), 'a released savepoint still rolls back with its transaction');
  }

  // --- savepoints under one parent take turns -------------------------------------
  await reset();
  {
    await db.withTransaction(async () => {
      const [a, b] = await Promise.allSettled([
        db.withTransaction(async () => {
          await db.run(`INSERT INTO t (name) VALUES ('sp-a')`);
          await tick(30);
          throw new Error('a');
        }),
        db.withTransaction(() => db.run(`INSERT INTO t (name) VALUES ('sp-b')`)),
      ]);
      assert.strictEqual(a.status, 'rejected');
      assert.strictEqual(b.status, 'fulfilled');
    });
    assert.deepStrictEqual(await names(), ['sp-b'], "rolling back one savepoint did not take its sibling's write with it");
  }

  // --- two transactions at once run one after the other ----------------------------
  {
    const order = [];
    const bump = (label) => db.withTransaction(async () => {
      order.push(`${label}:start`);
      const { n } = await db.get(`SELECT n FROM counter WHERE id = 1`);
      await tick(30);
      await db.run(`UPDATE counter SET n = ? WHERE id = 1`, [n + 1]);
      order.push(`${label}:end`);
    });
    await within(3000, Promise.all([bump('a'), bump('b')]), 'two concurrent transactions');
    assert.deepStrictEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], 'the second transaction began after the first ended');
    assert.strictEqual((await db.get(`SELECT n FROM counter WHERE id = 1`)).n, 2, 'no lost update');
  }

  // --- first come, first served: a waiting transaction is not overtaken ------------
  {
    const entered = gate();
    const held = gate();
    const order = [];
    const t1 = db.withTransaction(async () => { entered.open(); await held.wait; order.push('t1'); });
    await entered.wait;
    const t2 = db.withTransaction(async () => { order.push('t2'); });
    const read = db.get(`SELECT 1 AS one`).then(() => order.push('read'));
    held.open();
    await within(3000, Promise.all([t1, t2, read]), 'queued work');
    assert.deepStrictEqual(order, ['t1', 't2', 'read'], 'a read issued behind a waiting transaction runs after it');
  }

  // --- a statement the callback did not await runs on its own ------------------------
  await reset();
  {
    const next = gate();
    let late;
    await db.withTransaction(async () => {
      late = (async () => { await next.wait; return db.run(`INSERT INTO t (name) VALUES ('stale')`); })();
    });
    // A second transaction now holds the connection and is going to roll back.
    // The leftover statement from the first must wait for it, not join it.
    const held = gate();
    const second = db.withTransaction(async () => {
      next.open();
      await tick(30);
      await held.wait;
      throw new Error('second');
    });
    await tick(60);
    held.open();
    await assert.rejects(second, /second/);
    await late;
    assert.deepStrictEqual(await names(), ['stale'], 'the leftover write ran on its own instead of inside the rolled-back transaction');
  }

  // --- a BEGIN that fails does not wedge the connection --------------------------------
  {
    const other = new sqlite3.Database(tmpDb);
    const otherRun = (sql) => new Promise((resolve, reject) => other.run(sql, err => (err ? reject(err) : resolve())));
    await otherRun(`BEGIN IMMEDIATE`);              // another process holding the write lock
    await db.run(`PRAGMA busy_timeout = 50`);
    await assert.rejects(db.withTransaction(async () => {}), /SQLITE_BUSY|locked/i);
    await otherRun(`ROLLBACK`);
    await new Promise(resolve => other.close(() => resolve()));
    await db.run(`PRAGMA busy_timeout = 5000`);
    assert.strictEqual(await within(3000, db.withTransaction(async () => (await db.get(`SELECT 1 AS one`)).one), 'a transaction after a failed BEGIN'), 1);
  }

  console.log('dbtransaction ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
