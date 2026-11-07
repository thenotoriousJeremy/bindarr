// Emits /sw.js on a production build: the rules from src/utils/swPolicy.js and
// the worker body from src/sw/worker.js, with the build's version and file list
// in front. Hand-assembled rather than bundled so the output is one classic
// script with no imports, which every browser runs as a service worker.
//
// The version hashes the precache list and the worker's own source, so every
// deploy that changes either gets a new shell cache, and one that changes
// nothing keeps the old one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, '..', 'src');

// Larger chunks than this are fetched (and cached) only if a page asks for them.
const MAX_PRECACHE_BYTES = 1024 * 1024;

// swPolicy.js is an ES module so Node can test it; as part of a classic script
// its `export` keywords have to go. It promises to have no imports.
export function inlinePolicy(source) {
  if (/^\s*import\s/m.test(source)) throw new Error('swPolicy.js must not import anything');
  return source.replace(/^export (const|function|async function) /gm, '$1 ');
}

export function precacheList(bundle) {
  return Object.values(bundle)
    .filter(f => f.fileName.startsWith('assets/') && /\.(js|css)$/.test(f.fileName))
    .filter(f => (f.type === 'chunk' ? f.code : f.source).length <= MAX_PRECACHE_BYTES)
    .map(f => `/${f.fileName}`)
    .sort();
}

export default function serviceWorker({ version }) {
  return {
    name: 'bindarr-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = precacheList(bundle);
      const policy = inlinePolicy(readFileSync(path.join(src, 'utils', 'swPolicy.js'), 'utf8'));
      const worker = readFileSync(path.join(src, 'sw', 'worker.js'), 'utf8');
      const hash = createHash('sha256').update([...files, policy, worker].join('\n')).digest('hex').slice(0, 10);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: [
          `const SW_VERSION = ${JSON.stringify(`${version}-${hash}`)};`,
          `const PRECACHE = ${JSON.stringify(files)};`,
          policy,
          worker,
        ].join('\n'),
      });
    },
  };
}
