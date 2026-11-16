// The file format of Bindarr's own scan catalogs (the `scan-catalogs` release).
//
// A catalog is published as a BASE segment (every row) followed by DELTA segments
// (rows added or re-embedded since, and ids removed). An install downloads the
// base once and then only the deltas it has not applied; when deltas pile up, the
// build writes a new base under the next `generation` and installs start over
// from it (scripts/scan-catalogs/build.mjs). Applying a list in order gives the
// catalog: `applySegments`.
//
// One segment, little-endian:
//
//   'BCS1'                      4 bytes, magic
//   header length (uint32)      4 bytes, a multiple of 4
//   header (UTF-8 JSON)         { format, key, game, lang, model, dim, generation,
//                                 seq, base, rows, ids: [...], removes: [...], createdAt }
//                               padded with spaces to the length above
//   vectors                     rows x dim IEEE half floats (float16)
//
// float16, not float32: half the bytes for a difference cosine search cannot see
// (unit vectors' components are ~0.1, float16 keeps ~3 significant digits; the
// author's own catalogs are float16 too). Ids are Bindarr card ids, so every
// match names a card the app can resolve.
//
// CommonJS, no dependencies and no Buffer: the phone app bundles this too
// (backend/src/embedded), so it sticks to Uint8Array, DataView and TextEncoder.
'use strict';

const MAGIC = [0x42, 0x43, 0x53, 0x31];   // 'BCS1'
const FORMAT = 1;

// --- float16 -----------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

// float32 -> float16 bits, round to nearest even.
function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);       // inf / nan
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;                                  // overflow -> inf
  if (e <= 0) {                                                         // subnormal or zero
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    const half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    return sign | (half + (rest > mid || (rest === mid && (half & 1)) ? 1 : 0));
  }
  const half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? 1 : 0));
}

// float16 bits -> number.
function fromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// Every float16 value, once: the whole Magic catalog is 14 million of them, and a
// table read is several times cheaper than the arithmetic above (a phone notices).
let HALF_TABLE = null;
function halfTable() {
  if (!HALF_TABLE) {
    HALF_TABLE = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) HALF_TABLE[h] = fromHalf(h);
  }
  return HALF_TABLE;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// --- one segment -----------------------------------------------------------------

// `vectors`: a Float32Array of rows x dim, row-major, in `ids` order.
function encodeSegment({ key, game, lang, model = 'milo1', dim, generation, seq, base, ids, vectors, removes = [] }) {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error('segment: bad dim');
  if (vectors.length !== ids.length * dim) throw new Error(`segment: ${ids.length} ids but ${vectors.length / dim} vectors`);
  const header = JSON.stringify({
    format: FORMAT, key, game, lang, model, dim, generation, seq, base: !!base,
    rows: ids.length, ids, removes, createdAt: new Date().toISOString(),
  });
  const raw = new TextEncoder().encode(header);
  const headerLen = Math.ceil(raw.length / 4) * 4;
  const out = new Uint8Array(8 + headerLen + vectors.length * 2);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, headerLen, true);
  out.set(raw, 8);
  out.fill(0x20, 8 + raw.length, 8 + headerLen);                       // pad with spaces
  const body = 8 + headerLen;
  for (let i = 0; i < vectors.length; i++) view.setUint16(body + i * 2, toHalf(vectors[i]), true);
  return out;
}

// -> { header, halves: Uint16Array (rows x dim) }. Throws on anything malformed:
// a truncated or foreign file must never load as a catalog that scores wrong.
function decodeSegment(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || MAGIC.some((b, i) => u8[i] !== b)) throw new Error('segment: not a Bindarr catalog segment');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLen = view.getUint32(4, true);
  if (8 + headerLen > u8.length) throw new Error('segment: header runs past the end of the file');
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + headerLen)));
  if (header.format !== FORMAT) throw new Error(`segment: format ${header.format} is not supported`);
  const { rows, dim } = header;
  if (!Array.isArray(header.ids) || header.ids.length !== rows) throw new Error('segment: id count does not match rows');
  const body = 8 + headerLen;
  if (u8.length !== body + rows * dim * 2) {
    throw new Error(`segment: ${u8.length} bytes, expected ${body + rows * dim * 2}`);
  }
  // Copied into fresh memory, which also makes it 2-byte aligned whatever offset the
  // file's bytes arrived at. Not `u8.slice()`: on a Node Buffer that is a VIEW of
  // a shared pool, and its `.buffer` is the whole pool.
  let halves;
  if (LITTLE_ENDIAN) {
    const copy = new Uint8Array(rows * dim * 2);
    copy.set(u8.subarray(body, body + rows * dim * 2));
    halves = new Uint16Array(copy.buffer);
  } else {
    halves = Uint16Array.from({ length: rows * dim }, (_, i) => view.getUint16(body + i * 2, true));
  }
  return { header, halves };
}

// --- a catalog -------------------------------------------------------------------

// Decoded segments, in publication order -> { ids, cat: Float32Array, dim, rows }.
// A base starts over; a delta's removes go first, then its rows replace any row
// with the same id. Order of the result: the order rows were last written.
function applySegments(segments) {
  const where = new Map();   // id -> [segment index, row]
  let dim = null;
  segments.forEach((seg, s) => {
    const h = seg.header;
    if (dim == null) dim = h.dim;
    if (h.dim !== dim) throw new Error(`segment ${s}: dim ${h.dim} after ${dim}`);
    if (h.base) where.clear();
    for (const id of h.removes || []) where.delete(id);
    h.ids.forEach((id, row) => { where.delete(id); where.set(id, [s, row]); });
  });
  const ids = [...where.keys()];
  const cat = new Float32Array(ids.length * (dim || 0));
  const table = halfTable();
  let i = 0;
  for (const [s, row] of where.values()) {
    const src = segments[s].halves;
    const from = row * dim;
    for (let d = 0; d < dim; d++) cat[i * dim + d] = table[src[from + d]];
    i++;
  }
  return { ids, cat, dim: dim || 0, rows: ids.length };
}

// The rows of one segment as float32, for a build diffing against what it published.
const segmentVectors = (seg) => {
  const table = halfTable();
  return Float32Array.from(seg.halves, h => table[h]);
};

module.exports = { encodeSegment, decodeSegment, applySegments, segmentVectors, toHalf, fromHalf, FORMAT };
