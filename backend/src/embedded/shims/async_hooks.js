// AsyncLocalStorage for a WebView, which has no async context to carry a store.
//
// db.js uses it for one question: is this statement part of the transaction that
// owns the connection, or does it wait for that transaction to finish? A browser
// cannot follow a store across awaits, so this answers it more loosely: while
// run()'s callback is pending, every caller sees its store. A statement issued
// during a transaction therefore joins that transaction rather than waiting
// behind it, and a second withTransaction becomes a savepoint inside the first.
//
// That is how device mode behaved before the lock existed, and it cannot
// deadlock: nothing inside a transaction is ever queued behind it. Losing the
// isolation costs little on a phone, which has one user and no concurrent
// requests from other people. A store left behind by out-of-order settling is
// harmless too: db.js only acts on a store whose transaction still owns the
// connection.
'use strict';

let current;

class AsyncLocalStorage {
  getStore() {
    return current;
  }

  run(store, fn, ...args) {
    const previous = current;
    current = store;
    const restore = () => { if (current === store) current = previous; };
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

module.exports = { AsyncLocalStorage };
