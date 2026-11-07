import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { loadNpz } from './npz.js';

// A version-1 .npy file around raw little-endian bytes.
function npy(descr, shape, body) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  while ((10 + header.length + 1) % 64) header += ' ';
  header += '\n';
  const out = new Uint8Array(10 + header.length + body.length);
  out.set([0x93, ...Buffer.from('NUMPY'), 1, 0, header.length & 0xff, header.length >> 8]);
  out.set(Buffer.from(header, 'latin1'), 10);
  out.set(body, 10 + header.length);
  return out;
}

// A zip with one member per entry, STORED or DEFLATE as asked.
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const payload = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, Buffer.from(payload));
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + payload.length;
  }
  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBytes, eocd]));
}

const floats = new Float32Array([0.5, -1, 2, 0.25]);
const ids = Buffer.alloc(2 * 3 * 4);
['ab', 'xyz'].forEach((s, i) => [...s].forEach((ch, j) => ids.writeUInt32LE(ch.codePointAt(0), (i * 3 + j) * 4)));

for (const deflate of [false, true]) {
  const archive = zip([
    { name: 'embeddings.npy', data: npy('<f4', [2, 2], new Uint8Array(floats.buffer)), deflate },
    { name: 'card_ids.npy', data: npy('<U3', [2], new Uint8Array(ids)), deflate },
  ]);
  const npz = await loadNpz(archive);
  assert.deepStrictEqual(npz.embeddings.shape, [2, 2]);
  assert.deepStrictEqual(Array.from(npz.embeddings.data), [0.5, -1, 2, 0.25], `floats, ${deflate ? 'deflated' : 'stored'}`);
  assert.deepStrictEqual(npz.card_ids.data, ['ab', 'xyz'], `UTF-32 strings, ${deflate ? 'deflated' : 'stored'}`);
}

console.log('npz.test.js OK');
