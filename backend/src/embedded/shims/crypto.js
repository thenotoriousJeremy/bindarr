// `crypto` inside the phone app.
//
// randomBytes is the one the device needs — share tokens and its own session
// token — and WebCrypto's getRandomValues is the same CSPRNG quality Node's is.
// The auth gate also needs SHA-256 (see createHash below).
// Everything else the backend imports crypto for is a password, an OIDC
// signature or a metered provider's cache key, none of which device mode has:
// there is no login, no SSO, and no server environment to hold that provider's
// key. Those throw instead of quietly returning something weaker.
'use strict';

function encode(bytes, encoding) {
  if (encoding === 'hex') return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  if (encoding === 'base64' || encoding === 'base64url') {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary);
    return encoding === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return new TextDecoder().decode(bytes);
}

function randomBytes(size, callback) {
  const bytes = new Uint8Array(size);
  // getRandomValues fills at most 65536 bytes per call.
  for (let i = 0; i < size; i += 65536) globalThis.crypto.getRandomValues(bytes.subarray(i, i + 65536));
  bytes.toString = (encoding) => encode(bytes, encoding);
  if (typeof callback === 'function') {
    callback(null, bytes);
    return undefined;
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// SHA-256, synchronously, because the auth gate needs it on every request: the
// sessions table stores a hash of each token (authHelpers.hashSessionToken), and
// WebCrypto's digest is async. Plain FIPS 180-4; embedded.test.js checks it
// against Node's own. Only 'sha256' -- anything else still throws.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data) {
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(data);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== 'sha256') return unavailable(`createHash('${algorithm}')`)();
  const chunks = [];
  const hash = {
    update(input) {
      chunks.push(typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input));
      return hash;
    },
    digest(encoding) {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      const bytes = sha256(all);
      return encoding ? encode(bytes, encoding) : bytes;
    },
  };
  return hash;
}

function unavailable(name) {
  return () => {
    throw new Error(`crypto.${name} is not available when Bindarr runs on the device`);
  };
}

module.exports = {
  randomBytes,
  timingSafeEqual,
  randomUUID: () => globalThis.crypto.randomUUID(),
  createHash,
  createHmac: unavailable('createHmac'),
  pbkdf2Sync: unavailable('pbkdf2Sync'),
  X509Certificate: undefined,
};
