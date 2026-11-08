import assert from 'node:assert';
import { createDeviceDriver, statementKind, rows } from './deviceSqlite.js';

// A stand-in for @capacitor-community/sqlite that records every call, answering
// with the shapes the plugin's Android and iOS sources return.
function fakePlugin({ queryValues = [] } = {}) {
  const calls = [];
  const record = (name, result) => async (options) => { calls.push([name, options]); return result; };
  return {
    calls,
    checkConnectionsConsistency: record('checkConnectionsConsistency', { result: false }),
    createConnection: record('createConnection'),
    open: record('open'),
    close: record('close'),
    closeConnection: record('closeConnection'),
    beginTransaction: record('beginTransaction', { changes: { changes: 0 } }),
    commitTransaction: record('commitTransaction', { changes: { changes: 0 } }),
    rollbackTransaction: record('rollbackTransaction', { changes: { changes: 0 } }),
    run: record('run', { changes: { changes: 1, lastId: 42, values: [] } }),
    query: record('query', { values: queryValues }),
  };
}

// --- which plugin call each statement becomes --------------------------------
assert.strictEqual(statementKind('BEGIN IMMEDIATE TRANSACTION'), 'begin');
assert.strictEqual(statementKind('  commit'), 'commit');
assert.strictEqual(statementKind('ROLLBACK'), 'rollback');
assert.strictEqual(statementKind('ROLLBACK TO sp1'), 'statement', 'a savepoint rollback is an ordinary statement');
assert.strictEqual(statementKind('PRAGMA table_info(collection)'), 'pragma');
assert.strictEqual(statementKind('\n  INSERT INTO notes (title) VALUES (?)'), 'statement');

// --- open: one clean connection, named the way the plugin stores it ----------
{
  const plugin = fakePlugin();
  const driver = createDeviceDriver(plugin);
  await driver.open('bindarr.db');
  assert.deepStrictEqual(plugin.calls.map(c => c[0]), ['checkConnectionsConsistency', 'createConnection', 'open'],
    'a reload\'s leftover native connections are cleared before connecting');
  assert.deepStrictEqual(plugin.calls[0][1], { dbNames: [], openModes: [] });
  assert.strictEqual(plugin.calls[1][1].database, 'bindarr', 'the plugin appends its own SQLite.db suffix');
  assert.strictEqual(plugin.calls[1][1].encrypted, false);
}

// --- statements --------------------------------------------------------------
{
  const plugin = fakePlugin();
  const driver = createDeviceDriver(plugin);
  await driver.open('bindarr.db');
  plugin.calls.length = 0;

  const result = await driver.run('INSERT INTO notes (title) VALUES (?)', ['x']);
  assert.deepStrictEqual(result, { lastID: 42, changes: 1 });
  const [name, options] = plugin.calls[0];
  assert.strictEqual(name, 'run');
  assert.strictEqual(options.transaction, false,
    'never let the plugin wrap a statement in its own transaction — db.js opens its own');
  assert.deepStrictEqual(options.values, ['x']);

  for (const [sql, call] of [
    ['BEGIN IMMEDIATE TRANSACTION', 'beginTransaction'],
    ['COMMIT', 'commitTransaction'],
    ['ROLLBACK', 'rollbackTransaction'],
    ['PRAGMA foreign_keys = ON', 'query'],
    ['PRAGMA busy_timeout = 5000', 'query'],
  ]) {
    plugin.calls.length = 0;
    assert.deepStrictEqual(await driver.run(sql, []), { lastID: 0, changes: 0 });
    assert.deepStrictEqual(plugin.calls.map(c => c[0]), [call], `${sql} goes through ${call}`);
  }

  plugin.calls.length = 0;
  await driver.run('PRAGMA journal_mode = WAL', []);
  assert.strictEqual(plugin.calls.length, 0, 'journal_mode is left to the platform');
}

// --- a run that changed nothing reports nothing ------------------------------
{
  const plugin = fakePlugin();
  plugin.run = async () => ({ changes: { changes: 0, lastId: -1 } });
  const driver = createDeviceDriver(plugin);
  await driver.open('bindarr.db');
  assert.deepStrictEqual(await driver.run('UPDATE notes SET title = ? WHERE id = ?', ['x', 9]), { lastID: 0, changes: 0 },
    'iOS reports lastId -1 for a statement that inserted nothing');
}

// --- results: Android rows as-is, iOS rows without the column header ---------
assert.deepStrictEqual(rows(undefined), []);
assert.deepStrictEqual(rows([{ id: 1, name: 'a' }]), [{ id: 1, name: 'a' }]);
{
  const ios = rows([{ ios_columns: ['id', 'name'] }, { name: 'a', id: 1 }, { name: 'b', id: 2 }]);
  assert.deepStrictEqual(ios, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  assert.deepStrictEqual(Object.keys(ios[0]), ['id', 'name'], 'iOS rows come back in column order');

  const plugin = fakePlugin({ queryValues: [{ ios_columns: ['n'] }, { n: 3 }] });
  const driver = createDeviceDriver(plugin);
  await driver.open('bindarr.db');
  assert.deepStrictEqual(await driver.all('SELECT COUNT(*) n FROM notes', []), [{ n: 3 }]);
}
