// Turns at the phone's one database connection, for device mode (MOB-02).
//
// On a server, db.js keeps a transaction's statements apart from everyone else's
// with AsyncLocalStorage. A WebView has no async context, so in the app every
// statement issued while ANY transaction is open joins it (shims/async_hooks.js).
// With nothing running beside a request that was harmless, but background jobs
// do run beside it, and the two went wrong both ways: a background job that
// rolled back took a request's answered save with it, and a request whose own
// transaction became a savepoint in a background one failed at RELEASE after its
// rows had committed, so retrying it added the copy twice.
//
// So the work that touches the database takes turns, first come first served:
//   - each request, from the moment handle() starts it until it has answered;
//   - each background job that opens transactions (exchange rates, the trash
//     purge, the TCGCSV syncs, a TCGplayer-catalogue game's first write, the
//     Pokémon product map), as a "background" unit.
// While a unit holds the lock, the only transaction-opening code running is its
// own, which is the one thing the shim cannot work out for itself.
//
// No unit waits on the network while holding it. A background unit lets go for
// its fetches (outside()) and, between two transactions, for any request queued
// behind it (yield()). A request is the exception it cannot be: the route makes
// its provider calls in the middle of its turn, which on a phone with one user
// means the next request waits for that answer, at most a provider timeout.
'use strict';

function abortError() {
  // The WebView's DOMException, so fetch's callers see the AbortError they expect.
  if (typeof DOMException === 'function') return new DOMException('The request was aborted.', 'AbortError');
  return Object.assign(new Error('The request was aborted.'), { name: 'AbortError' });
}

// unit: any object, compared by identity; { name, background } by convention.
function createUnitLock() {
  let holder = null;
  const queue = [];   // { unit, grant, cancelled }

  function grantNext() {
    while (!holder && queue.length) {
      const next = queue.shift();
      if (next.cancelled) continue;
      holder = next.unit;
      next.grant();
    }
  }

  // Resolves once `unit` holds the lock. A signal that aborts while it is still
  // queued takes it out of the queue, so it never runs at all.
  function acquire(unit, { signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = { unit, grant: resolve, cancelled: false };
      if (signal) {
        const onAbort = () => {
          entry.cancelled = true;
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.grant = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
      }
      queue.push(entry);
      grantNext();
    });
  }

  function release(unit) {
    if (holder !== unit) throw new Error(`${(unit && unit.name) || 'a unit'} released a lock it does not hold`);
    holder = null;
    grantNext();
  }

  async function run(unit, fn, options) {
    await acquire(unit, options);
    try {
      return await fn(unit);
    } finally {
      release(unit);
    }
  }

  const waiting = () => queue.filter(e => !e.cancelled).length;

  // Let whoever is queued go first, then carry on. Only between transactions:
  // a unit that yielded inside one would let a request's statements into it.
  async function yieldTurn(unit) {
    if (holder !== unit || waiting() === 0) return;
    release(unit);
    await acquire(unit);
  }

  // Run fn without the lock (a network fetch), then queue for it again.
  async function outside(unit, fn) {
    release(unit);
    try {
      return await fn();
    } finally {
      await acquire(unit);
    }
  }

  return { acquire, release, run, yieldTurn, outside, waiting, holder: () => holder };
}

module.exports = { createUnitLock, abortError };
