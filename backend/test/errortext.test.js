// Internal error text stays in the server log (SEC-10).
//
// The notes routes and the import/export routes answered a 500 with the raw
// SQLite message in `message`. AGENTS.md asks for client-safe errors: the client
// gets a fixed sentence, the log gets the detail. (The OIDC callback's redirect
// is covered by oidchardening.test.js.)
//
// The real routers in this process with a stand-in for the auth gate; the
// database is made to fail on cue. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-errortext-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let server;
async function cleanup() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const SECRET = 'SQLITE_CORRUPT: database disk image is malformed (table notes, page 4711)';

// Make one db method fail while `fn` runs, and keep what the server logged.
async function failing(method, fn) {
  const real = db[method];
  const realError = console.error;
  const logged = [];
  db[method] = async () => { throw new Error(SECRET); };
  console.error = (...args) => { logged.push(args.map(a => (a && a.message) || String(a)).join(' ')); };
  try {
    return { result: await fn(), logged };
  } finally {
    db[method] = real;
    console.error = realError;
  }
}

async function main() {
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('writer', 'x', 'tok-w')`)).lastID;
  const note = (await db.run(`INSERT INTO notes (user_id, title, body) VALUES (?, 'Mine', 'text')`, [userId])).lastID;
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('base1-4', 'Charizard', 'pokemon')`);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => { req.user = { id: userId, role: 'member' }; next(); });
  app.use('/api', require('../src/routes/notes'));
  app.use('/api', require('../src/routes/importExport'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  const cases = [
    ['all', 'GET', '/api/notes'],
    ['run', 'POST', '/api/notes', { title: 'New' }],
    ['run', 'PUT', `/api/notes/${note}`, { title: 'Renamed' }],
    ['run', 'DELETE', `/api/notes/${note}`],
    ['all', 'GET', '/api/export?format=csv'],
    ['withTransaction', 'POST', '/api/import', { format: 'json', data: [{ card_id: 'base1-4', game: 'pokemon', quantity: 1 }] }],
  ];
  for (const [method, verb, url, body] of cases) {
    const { result, logged } = await failing(method, () => call(verb, url, body));
    assert.strictEqual(result.status, 500, `${verb} ${url}: ${result.text}`);
    assert.ok(!result.text.includes('SQLITE') && !result.text.includes('4711'), `${verb} ${url} must not echo the database's error: ${result.text}`);
    assert.ok(JSON.parse(result.text).error, `${verb} ${url} still says what failed`);
    assert.ok(logged.some(l => l.includes('4711')), `${verb} ${url} logs the real error`);
  }
  console.log('PASS: notes and import/export 500s are client-safe, with the detail in the log');

  console.log('PASS: errortext.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
