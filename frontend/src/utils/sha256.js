// SHA-256 of a download, as lowercase hex: what device mode checks every scan
// model, snapshot and release segment against before keeping it
// (device/scanAssets.js).
//
// WebCrypto when the WebView has it. A WebView only exposes crypto.subtle in a
// secure context, and a phone that lacks it must still check what it downloads
// rather than keep the file unchecked or refuse it outright, so this falls back to
// a plain JavaScript SHA-256 (FIPS 180-4). The fallback hashes a megabyte at a
// time and yields between, so the app keeps drawing while a 56 MB snapshot is
// checked. Tested against the FIPS vectors and WebCrypto's own answers
// (sha256.test.js).

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

// Bytes hashed between two yields to the event loop.
const SLICE = 1 << 20;

const toBytes = (data) => (ArrayBuffer.isView(data)
  ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  : new Uint8Array(data));

const hex = (words) => Array.from(words, w => (w >>> 0).toString(16).padStart(8, '0')).join('');

// The compression function over data[start, end), whole 64-byte blocks, into H.
function blocks(H, W, data, start, end) {
  let h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];
  for (let off = start; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  H[0] = h0; H[1] = h1; H[2] = h2; H[3] = h3; H[4] = h4; H[5] = h5; H[6] = h6; H[7] = h7;
}

// The JavaScript SHA-256, whatever the WebView offers. Resolves to hex.
export async function sha256HexJs(data) {
  const bytes = toBytes(data);
  const H = new Int32Array(H0);
  const W = new Int32Array(64);
  const whole = bytes.length - (bytes.length % 64);
  for (let at = 0; at < whole; at += SLICE) {
    blocks(H, W, bytes, at, Math.min(at + SLICE, whole));
    if (at + SLICE < whole) await new Promise(resolve => setTimeout(resolve, 0));
  }
  // The last partial block, the 0x80 marker and the length in bits (big-endian,
  // 64-bit): one block, or two when fewer than 9 bytes are left in the first.
  const rest = bytes.length - whole;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(bytes.subarray(whole));
  tail[rest] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(tail.length - 4, (bytes.length * 8) >>> 0);
  blocks(H, W, tail, 0, tail.length);
  return hex(H);
}

// SHA-256 as hex: WebCrypto's when there is one (and it answers), else the
// JavaScript one. `subtle` is for tests.
export async function sha256Hex(data, { subtle = globalThis.crypto?.subtle } = {}) {
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', toBytes(data));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    } catch { /* the same answer, the slower way */ }
  }
  return sha256HexJs(data);
}
