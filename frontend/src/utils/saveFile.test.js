import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { saveFile, saveStrategy, safeFileName } from './saveFile.js';

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
