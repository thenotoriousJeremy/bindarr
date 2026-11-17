import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { sha256Hex, sha256HexJs } from './sha256.js';

const text = (s) => new TextEncoder().encode(s);
const webCrypto = async (bytes) => Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', bytes)).toString('hex');

// Bytes that are not all alike, so a byte-order or word-boundary slip shows.
function pattern(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

// FIPS 180-2's examples (appendix B) and the NIST CAVS "long message" one.
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

test('the JavaScript SHA-256 gives the published answers', async () => {
  for (const [input, digest] of VECTORS) {
    assert.strictEqual(await sha256HexJs(text(input)), digest, `${input.length} bytes`);
  }
});

test('it agrees with WebCrypto at every padding boundary', async () => {
  // 55/56 and 119/120: where the length stops fitting the last block and padding
  // takes a second one; 63/64/65 and 127/128: whole blocks either side.
  const lengths = [...Array.from({ length: 200 }, (_, i) => i), 447, 448, 511, 512, 1000, 4095, 4096, 4097];
  for (const n of lengths) {
    const bytes = pattern(n, n + 7);
    assert.strictEqual(await sha256HexJs(bytes), await webCrypto(bytes), `${n} bytes`);
  }
});

test('a download several slices long, with the event loop let in between', async () => {
  // Past the 1 MB slices it yields between, ending mid-block.
  const bytes = pattern(3 * 1024 * 1024 + 4133, 42);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  const digest = await sha256HexJs(bytes);
  clearInterval(timer);
  assert.strictEqual(digest, await webCrypto(bytes));
  assert.strictEqual(digest, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(ticks > 0, 'other work ran while it hashed');
});

test('any view of the bytes, not only a whole Uint8Array', async () => {
  const all = pattern(300, 3);
  const view = all.subarray(17, 217);
  const expected = await webCrypto(view.slice());
  assert.strictEqual(await sha256HexJs(view), expected, 'a subarray hashes its own bytes, not the buffer');
  assert.strictEqual(await sha256HexJs(view.slice().buffer), expected, 'an ArrayBuffer');
  assert.strictEqual(await sha256Hex(view), expected, 'WebCrypto, given the same view');
});

test('sha256Hex uses WebCrypto when it is there, and the JavaScript one when it is not', async () => {
  const bytes = pattern(1234, 9);
  const expected = await webCrypto(bytes);
  assert.strictEqual(await sha256Hex(bytes), expected);
  assert.strictEqual(await sha256Hex(bytes, { subtle: null }), expected, 'no crypto.subtle (not a secure context)');
  let asked = 0;
  const failing = { digest: async () => { asked++; throw new Error('NotSupportedError'); } };
  assert.strictEqual(await sha256Hex(bytes, { subtle: failing }), expected, 'a WebCrypto that refuses');
  assert.strictEqual(asked, 1);
});
