// .npz reader for the browser: the published scan catalogs, read on the phone in
// device mode. A port of backend/src/utils/npz.js onto Uint8Array/DataView, with
// the platform's DecompressionStream in place of zlib — numpy writes members
// STORED (savez) or DEFLATE (savez_compressed), and both have to work.

const td = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function zipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no EOCD');
  let count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (off === 0xffffffff || count === 0xffff) {
    let z = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) { z = i; break; }
    }
    if (z < 0) throw new Error('zip64 sentinel but no locator');
    const z64 = Number(dv.getBigUint64(z + 8, true));
    count = Number(dv.getBigUint64(z64 + 32, true));
    off = Number(dv.getBigUint64(z64 + 48, true));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central header');
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    out.push({ name: td.decode(buf.subarray(off + 46, off + 46 + nameLen)), method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function entryData(buf, e) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The local header repeats the name/extra lengths and may differ from the
  // central copy, so they are re-read here.
  const start = e.localOff + 30 + dv.getUint16(e.localOff + 26, true) + dv.getUint16(e.localOff + 28, true);
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw);
  throw new Error(`unsupported zip method ${e.method}`);
}

const DTYPES = {
  '<f4': Float32Array, '<f8': Float64Array,
  '<i4': Int32Array, '<i8': BigInt64Array,
  '|i1': Int8Array, '|u1': Uint8Array, '<u4': Uint32Array,
};

export function parseNpy(b) {
  if (b[0] !== 0x93 || td.decode(b.subarray(1, 6)) !== 'NUMPY') throw new Error('not npy');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const major = b[6];
  const hlen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hstart = major === 1 ? 10 : 12;
  const header = td.decode(b.subarray(hstart, hstart + hlen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)[1].match(/\d+/g) || []).map(Number);
  const body = b.subarray(hstart + hlen);
  const n = shape.reduce((a, c) => a * c, 1);

  if (descr.startsWith('<U')) {           // fixed-width UTF-32 strings
    const w = parseInt(descr.slice(2), 10);
    const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const data = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = '';
      for (let j = 0; j < w; j++) {
        const cp = bv.getUint32((i * w + j) * 4, true);
        if (cp === 0) break;
        s += String.fromCodePoint(cp);
      }
      data[i] = s;
    }
    return { shape, data, descr };
  }
  if (descr.startsWith('|S')) {           // fixed-width bytes
    const w = parseInt(descr.slice(2), 10);
    const data = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = body.subarray(i * w, (i + 1) * w);
      const z = s.indexOf(0);
      data[i] = td.decode(z < 0 ? s : s.subarray(0, z));
    }
    return { shape, data, descr };
  }
  if (descr === '|O') throw new Error('pickled object array (needs allow_pickle)');
  const T = DTYPES[descr];
  if (!T) throw new Error(`unsupported dtype ${descr}`);
  // Copied: a member's payload need not sit on an element-size boundary, and a
  // typed-array view over a misaligned offset throws.
  const bytes = body.slice(0, n * T.BYTES_PER_ELEMENT);
  return { shape, data: new T(bytes.buffer, 0, n), descr };
}

// bytes: Uint8Array (or ArrayBuffer) of the whole .npz. Resolves { name: array }.
export async function loadNpz(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = {};
  for (const e of zipEntries(buf)) {
    const key = e.name.replace(/\.npy$/, '');
    try { out[key] = parseNpy(await entryData(buf, e)); }
    catch (err) { out[key] = { error: err.message }; }
  }
  return out;
}
