// Admin backup downloads work wherever the backups live (SEC-17).
//
// res.download hands Express 5's `send` the absolute path, and send refuses any
// path with a dot-folder in it: an install under ~/.local/share/... answered every
// backup download with a 404 (which the global error handler then called "Bad
// request body"). The download now goes through utils/sendFileAt, which only
// judges the file's own name, with an attachment header. (The global error
// handler's wording is covered by e2e/hardening.test.js.)
//
// The real admin router and auth gate in this process, with BACKUP_DIR inside a
// dot-folder. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-backupdownload-'));
process.env.DB_PATH = path.join(tmpDir, 'bindarr.db');
process.env.BACKUP_DIR = path.join(tmpDir, '.local', 'share', 'bindarr', 'backups');
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');

let server;
async function cleanup() {
  if (server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }
}

async function main() {
  await db.initDb();
  const adminId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('admin', 'x', 'admin', 'tok-a')`)).lastID;
  const token = await generateSession(adminId);

  fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });
  const file = 'bindarr.2026-11-15T00-00-00-000Z.bak';
  const content = Buffer.from('SQLite format 3\0 pretend snapshot');
  fs.writeFileSync(path.join(process.env.BACKUP_DIR, file), content);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../src/routes/admin'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const get = (p) => fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });

  const listed = await (await get('/api/admin/backups')).json();
  assert.deepStrictEqual(listed.backups.map(b => b.file), [file], 'the backup is listed');

  const res = await get(`/api/admin/backups/${file}/download`);
  assert.strictEqual(res.status, 200, 'a backup under a dot-folder downloads');
  assert.match(res.headers.get('content-disposition') || '', new RegExp(`^attachment; filename="?${file.replace(/\./g, '\\.')}"?$`),
    'as an attachment, named for the file');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(content), 'byte for byte');

  const missing = await get('/api/admin/backups/nope.bak/download');
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await missing.json(), { error: 'Backup not found' });
  console.log('PASS: admin backup downloads work from a dot-folder, as attachments');

  console.log('PASS: backupdownload.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
