// AsyncLocalStorage for a WebView, which has no async context to carry a store.
//
// db.js uses it for one question: is this statement part of the transaction that
// owns the connection, or does it wait for that transaction to finish? A browser
// cannot follow a store across awaits, so this answers it more loosely: while
// run()'s callback is pending, every caller sees its store. A statement issued
// during a transaction therefore joins that transaction rather than waiting
// behind it, and a second withTransaction becomes a savepoint inside the first.
//
// That is only safe while one piece of work runs at a time, and a phone does run
// background jobs beside the user's requests. So embedded/index.js makes it true:
// requests and the background jobs that open transactions take turns through one
// lock (embedded/units.js), and inTransaction() below is how it asks whether a
// transaction is open right now. It cannot deadlock: nothing inside a transaction
// is ever queued behind it. A store left behind by out-of-order settling is
// harmless to db.js, which only acts on a store whose transaction still owns the
// connection; the count below does not depend on settling order at all.
'use strict';

let current;
// run() callbacks with a store that have not settled yet: open transactions and
// savepoints. Counted rather than read off `current`, which out-of-order settling
// can leave pointing at a finished transaction.
let open = 0;

class AsyncLocalStorage {
  getStore() {
    return current;
  }

  run(store, fn, ...args) {
    const previous = current;
    current = store;
    const counted = store !== undefined;
    if (counted) open++;
    let settled = false;
    const restore = () => {
      if (settled) return;
      settled = true;
      if (counted) open--;
      if (current === store) current = previous;
    };
    let result;
    try {
      result = fn(...args);
    } catch (err) {
      restore();
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { restore(); return value; },
        (err) => { restore(); throw err; },
      );
    }
    restore();
    return result;
  }

  exit(fn, ...args) {
    return this.run(undefined, fn, ...args);
  }
}

// True while any transaction (or savepoint) callback is still running.
const inTransaction = () => open > 0;

module.exports = { AsyncLocalStorage, inTransaction };
