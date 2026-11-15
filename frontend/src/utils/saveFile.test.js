import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  saveFile, saveStrategy, safeFileName, writeAndShare, bytesToBase64, CHUNK_BYTES, KEEP_SHARED_MS,
} from './saveFile.js';

// @capacitor/filesystem and @capacitor/share as the phone has them, recording
// every call and the file each one leaves behind.
function fakePhone({ shareFails } = {}) {
  const files = new Map();
  const calls = [];
  const fs = {
    Directory: { Cache: 'CACHE' },
    Filesystem: {
      rmdir: async (o) => { calls.push(['rmdir', o.path]); for (const k of files.keys()) if (k.startsWith(`${o.path}/`)) files.delete(k); },
      mkdir: async (o) => { calls.push(['mkdir', o.path]); },
      writeFile: async (o) => {
        calls.push(['writeFile', o.path, o.data.length]);
        files.set(o.path, Buffer.from(o.data, 'base64'));
        return { uri: `file:///cache/${o.path}` };
      },
      appendFile: async (o) => {
        calls.push(['appendFile', o.path, o.data.length]);
        files.set(o.path, Buffer.concat([files.get(o.path), Buffer.from(o.data, 'base64')]));
      },
      deleteFile: async (o) => { calls.push(['deleteFile', o.path]); files.delete(o.path); },
    },
  };
  const share = {
    share: async (o) => {
      calls.push(['share', o.url]);
      if (shareFails) throw new Error(shareFails);
    },
  };
  return { fs, share, files, calls };
}

test('a large backup crosses to the phone in slices, never as one string (MOB-07)', async () => {
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 1234).map((_, i) => (i * 7) % 256);
  const phone = fakePhone();
  let cleanup = null;
  await writeAndShare(new Blob([bytes]), 'bindarr_backup.json', { ...phone, later: (fn, ms) => { cleanup = [fn, ms]; } });

  const writes = phone.calls.filter(c => c[0] === 'writeFile' || c[0] === 'appendFile');
  assert.deepEqual(writes.map(c => c[0]), ['writeFile', 'appendFile', 'appendFile']);
  assert.ok(writes.every(c => c[2] <= Math.ceil(CHUNK_BYTES / 3) * 4), 'no slice is bigger than one chunk of base64');
  assert.deepEqual(new Uint8Array(phone.files.get('exports/bindarr_backup.json')), bytes, 'the file is the blob, byte for byte');
  assert.deepEqual(phone.calls.find(c => c[0] === 'share'), ['share', 'file:///cache/exports/bindarr_backup.json']);

  // Removed once the receiving app has had time to read it.
  assert.equal(cleanup[1], KEEP_SHARED_MS);
  await cleanup[0]();
  assert.equal(phone.files.size, 0, 'the temporary copy is deleted after sharing');
});

test('a cancelled or failed share removes the file at once; an old export is cleared first', async () => {
  for (const [message, rejects] of [['Share canceled', false], ['No activity found', true]]) {
    const phone = fakePhone({ shareFails: message });
    phone.files.set('exports/old.json', Buffer.from('left behind'));
    const run = writeAndShare(new Blob(['{"a":1}']), 'x.json', { ...phone, later: () => assert.fail('nothing to schedule') });
    if (rejects) await assert.rejects(run, /No activity/);
    else await run;
    assert.equal(phone.files.size, 0, message);
    assert.deepEqual(phone.calls[0], ['rmdir', 'exports']);
  }
});

test('bytes become base64 the way btoa would', () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(CHUNK_BYTES % 3, 0, 'slices end on a base64 boundary');
});

test('the web build downloads, the native apps share', () => {
  assert.equal(saveStrategy({ native: false }), 'web');
  assert.equal(saveStrategy({ native: true }), 'native');
});

test('saveFile hands the file to exactly one path', async () => {
  const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
  for (const native of [false, true]) {
    const calls = [];
    await saveFile(blob, 'bindarr_collection.csv', {
      native,
      web: (b, name) => calls.push(['web', name, b]),
      share: async (b, name) => { calls.push(['native', name, b]); },
    });
    assert.deepEqual(calls, [[native ? 'native' : 'web', 'bindarr_collection.csv', blob]]);
  }
});

test('a native failure reaches the caller, so its error toast still shows', async () => {
  await assert.rejects(saveFile(new Blob([]), 'x.json', {
    native: true,
    share: async () => { throw new Error('disk full'); },
  }), /disk full/);
});

test('file names cannot escape the cache directory', () => {
  assert.equal(safeFileName('bindarr_collection.csv'), 'bindarr_collection.csv');
  assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFileName('mtg:abc/1.png'), 'mtg_abc_1.png');
});

test('no component builds its own blob download any more', () => {
  const dir = new URL('../components/', import.meta.url);
  for (const f of readdirSync(dir).filter(n => n.endsWith('.jsx'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /\.download\s*=/, `${f} sets a.download; use saveFile`);
  }
});
