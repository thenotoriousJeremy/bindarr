// A JSON response read only up to a size it has no business exceeding: device
// mode's release index and manifests (device/scanAssets.js), small files on a CDN
// whose answer the app trusts to decide what to download next. Without a cap, a
// wrong or hostile answer is read whole into the WebView's memory before
// JSON.parse ever sees it.
//
// A Content-Length over the cap is refused before the body is read, and a body
// that runs past it (no length given, or a compressed one) is refused as it
// streams. The server's side of the same rule is backend/src/utils/releaseAssets.js.

export class TooLargeError extends Error {
  constructor(what, maxBytes) {
    super(`${what} is larger than the ${maxBytes} bytes expected — refusing it`);
    this.name = 'TooLargeError';
    this.code = 'TOO_LARGE';
  }
}

// Resolves to the parsed body of `res` (a fetch Response), or rejects with
// TooLargeError past `maxBytes`, or with the parse error.
export async function readCappedJson(res, maxBytes, what = 'the response') {
  const declared = Number(res.headers && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new TooLargeError(what, maxBytes);
  }
  let bytes;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new TooLargeError(what, maxBytes);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new TooLargeError(what, maxBytes);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
