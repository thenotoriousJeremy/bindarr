// `crypto` inside the phone app.
//
// randomBytes is the one the device needs — share tokens and its own session
// token — and WebCrypto's getRandomValues is the same CSPRNG quality Node's is.
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

function unavailable(name) {
  return () => {
    throw new Error(`crypto.${name} is not available when Bindarr runs on the device`);
  };
}

module.exports = {
  randomBytes,
  timingSafeEqual,
  randomUUID: () => globalThis.crypto.randomUUID(),
  createHash: unavailable('createHash'),
  createHmac: unavailable('createHmac'),
  pbkdf2Sync: unavailable('pbkdf2Sync'),
  X509Certificate: undefined,
};
