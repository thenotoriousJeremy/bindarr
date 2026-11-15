// The scan-catalog segment format (utils/catalogSegments.js): what the weekly
// build publishes and every install applies. A wrong byte here is a catalog that
// loads and quietly scores every card wrong, so the round trip, the order rules
// and the refusal of anything malformed are all pinned.
//
// No framework — plain node + assert. Run: `node test/catalogsegments.test.js`
const assert = require('assert');
const seg = require('../src/utils/catalogSegments');

// float16: exact where it can be, close where it cannot, and the special values.
for (const v of [0, 1, -1, 0.5, -2, 65504, 2 ** -14]) assert.strictEqual(seg.fromHalf(seg.toHalf(v)), v, `${v} is exact`);
for (const v of [0.1234567, -0.0789, 0.31415926, 1e-5]) {
  const back = seg.fromHalf(seg.toHalf(v));
  assert.ok(Math.abs(back - v) <= Math.abs(v) * 1e-3 + 6e-8, `${v} -> ${back}`);
}
assert.strictEqual(seg.fromHalf(seg.toHalf(1e9)), Infinity);
assert.ok(Number.isNaN(seg.fromHalf(seg.toHalf(NaN))));

// A unit vector survives with cosine ~1 against itself.
const DIM = 128;
const unit = (seed) => {
  const v = new Float32Array(DIM);
  let s = seed;
  for (let i = 0; i < DIM; i++) { s = (s * 1103515245 + 12345) % 2147483648; v[i] = s / 2147483648 - 0.5; }
  const n = Math.hypot(...v);
  return v.map(x => x / n);
};
const rows = (ids) => {
  const out = new Float32Array(ids.length * DIM);
  ids.forEach((id, i) => out.set(unit(id.length * 7919 + id.charCodeAt(id.length - 1)), i * DIM));
  return out;
};

const base = seg.encodeSegment({
  key: 'mtg-en', game: 'mtg', lang: 'English', dim: DIM, generation: 1, seq: 0, base: true,
  ids: ['mtg-a', 'mtg-b', 'mtg-c'], vectors: rows(['mtg-a', 'mtg-b', 'mtg-c']),
});
const decoded = seg.decodeSegment(base);
assert.strictEqual(decoded.header.rows, 3);
assert.deepStrictEqual(decoded.header.ids, ['mtg-a', 'mtg-b', 'mtg-c']);
const a = seg.segmentVectors(decoded).subarray(0, DIM);
const orig = unit('mtg-a'.length * 7919 + 'a'.charCodeAt(0));
let dot = 0;
for (let i = 0; i < DIM; i++) dot += a[i] * orig[i];
assert.ok(dot > 0.9999, `cosine after float16 is ${dot}`);
assert.strictEqual(base.length, 8 + Math.ceil(new TextEncoder().encode(JSON.stringify(decoded.header)).length / 4) * 4 + 3 * DIM * 2,
  'header padded to 4 bytes, then two bytes a value');

// A delta: one new card, one re-embedded, one removed.
const delta = seg.encodeSegment({
  key: 'mtg-en', game: 'mtg', lang: 'English', dim: DIM, generation: 1, seq: 1, base: false,
  ids: ['mtg-d', 'mtg-b'], vectors: rows(['mtg-d', 'mtg-bb']), removes: ['mtg-c'],
});
const cat = seg.applySegments([decoded, seg.decodeSegment(delta)]);
assert.deepStrictEqual(cat.ids, ['mtg-a', 'mtg-d', 'mtg-b'], 'removed gone, the re-embedded row moves to its new place');
assert.strictEqual(cat.cat.length, 3 * DIM);
const bRow = cat.cat.subarray(2 * DIM, 3 * DIM);
const bNew = seg.segmentVectors(seg.decodeSegment(delta)).subarray(DIM, 2 * DIM);
assert.deepStrictEqual([...bRow], [...bNew], "the delta's vector replaced the base's");

// A later base starts over.
const base2 = seg.decodeSegment(seg.encodeSegment({
  key: 'mtg-en', game: 'mtg', lang: 'English', dim: DIM, generation: 2, seq: 0, base: true,
  ids: ['mtg-z'], vectors: rows(['mtg-z']),
}));
assert.deepStrictEqual(seg.applySegments([decoded, seg.decodeSegment(delta), base2]).ids, ['mtg-z']);

// A segment read from disk arrives as a Node Buffer, often a view into a shared pool
// at an odd offset. It must decode to the same vectors as the bytes it was made of
// (a Buffer's slice() is a view, and once decoded the whole pool as the catalog).
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), `bindarr-segment-${process.pid}.seg`);
  fs.writeFileSync(file, base);
  const fromDisk = seg.decodeSegment(fs.readFileSync(file));
  fs.rmSync(file, { force: true });
  assert.deepStrictEqual([...fromDisk.halves], [...decoded.halves], 'a file read back decodes like the bytes written');
  const odd = Buffer.concat([Buffer.from([7]), Buffer.from(base)]).subarray(1);
  assert.strictEqual(odd.byteOffset % 2, 1, 'the test really is at an odd offset');
  assert.deepStrictEqual([...seg.decodeSegment(odd).halves], [...decoded.halves], 'an odd offset into a larger buffer decodes the same');
  const pooled = Buffer.from(base);   // small Buffers share an 8 KB pool
  assert.deepStrictEqual([...seg.decodeSegment(pooled).halves], [...decoded.halves], 'a pooled Buffer decodes the same');
  // And the values are the ones encoded, to float16 precision.
  const back = seg.applySegments([seg.decodeSegment(pooled)]);
  const src = rows(back.ids);
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(src[i] - back.cat[i]) < 1e-3, `value ${i} survives`);
}

// Anything malformed is refused, never loaded.
assert.throws(() => seg.decodeSegment(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), /not a Bindarr/);
assert.throws(() => seg.decodeSegment(base.subarray(0, base.length - 2)), /bytes, expected/);
const tampered = Uint8Array.from(base);
tampered[4] = 0xff;
assert.throws(() => seg.decodeSegment(tampered), /past the end|JSON|Unexpected/);
assert.throws(() => seg.encodeSegment({ dim: DIM, ids: ['x'], vectors: new Float32Array(3) }), /1 ids but/);
assert.throws(() => seg.applySegments([decoded, { header: { ...decoded.header, dim: 64 }, halves: new Uint16Array(0) }]), /dim 64/);

console.log('catalogsegments.test.js: all assertions passed');
