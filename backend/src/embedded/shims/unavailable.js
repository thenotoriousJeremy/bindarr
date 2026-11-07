// Stand-in for a Node module that has no build for a phone — sharp,
// onnxruntime-node, zlib and the rest of the native or server-only list in
// ../aliases.js.
//
// Requiring it has to succeed, because routes/collection.js pulls in the scan
// pipeline at load time even though a request may never touch it. USING it —
// calling or constructing anything reached through it, at any depth — throws,
// loudly and with the reason. Nothing reaches that in practice: scanning answers
// 503 notBuilt first (the fs stub reports no catalog), the same answer a server
// gives before anyone has fetched the models.
'use strict';

function unavailable() {
  throw new Error('This feature needs a Bindarr server; it is not available when Bindarr runs on the device.');
}

const stub = new Proxy(unavailable, {
  get(target, prop) {
    if (prop === '__esModule') return false;
    // Not a thenable, so `await` on it cannot trip the throw by accident.
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return stub;
  },
  apply: unavailable,
  construct: unavailable,
});

module.exports = stub;
