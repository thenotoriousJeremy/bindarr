import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLURAL_SUFFIX } from './translate.js';

// translate() falls back to the key itself when en.json lacks it, so a missing
// key shows "common.add" on a button and a `t('x') || 'Fallback'` never runs.
// Every literal key the source passes to t() has to exist in en.json.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(join(SRC, 'locales', 'en.json'), 'utf8'));
const pluralBases = new Set(Object.keys(en).filter(k => PLURAL_SUFFIX.test(k)).map(k => k.replace(PLURAL_SUFFIX, '')));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'locales' && entry.name !== 'generated') yield* sourceFiles(path);
    } else if (/\.(jsx?|mjs)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
      yield path;
    }
  }
}

test('every literal t() key exists in en.json', () => {
  const missing = [];
  for (const file of sourceFiles(SRC)) {
    // Comments only describe calls (`// t('key', { count })`), so they are left out.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/\bt\(\s*(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g)) {
      const key = m[2];
      if (key in en || pluralBases.has(key)) continue;
      missing.push(`${relative(SRC, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
