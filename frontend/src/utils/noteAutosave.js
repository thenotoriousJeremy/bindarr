// Autosave for text being typed (Notes). Each key, one field of one note, is
// saved a moment after the typing stops, and at once on flush(): the field
// losing focus, the tab being hidden or left, the page going away. Notes used
// to save on blur alone, so closing the tab or backgrounding the app mid-edit
// lost the text.
//
//   - Text the server already has is never sent again, so a blur after the
//     timer fired, or two flushes in a row, cost nothing.
//   - Saves of one key never overlap: each waits for the one before it, so the
//     newest text is what lands last.
//   - A failed save keeps the edit. It goes out again with the next edit or
//     flush, and onError says so once per failure.
//
// No React and no timers of its own (they are passed in), so it runs under
// node:test.
//
//   const saver = createAutosave({ save, delay, onError });
//   saver.edit(key, text, original)   typed; `original` is the saved text, used
//                                     the first time a key is seen
//   saver.flush(key) / flushAll()     save now; resolve when done
//   saver.isDirty(key)                typed text the server does not have yet
//   saver.forget(key)                 drop a key (its note was deleted)
//   saver.dispose()                   stop the timers
export function createAutosave({
  save,
  delay = 800,
  onError,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const entries = new Map(); // key -> { saved, latest, timer, chain }

  const cancelTimer = (e) => {
    if (e.timer != null) { clearTimer(e.timer); e.timer = null; }
  };

  async function saveNow(key, e) {
    const value = e.latest;
    if (value === e.saved) return;
    let ok;
    try {
      ok = (await save(key, value)) !== false;
    } catch {
      ok = false;
    }
    if (ok) e.saved = value;
    else if (onError) onError(key, value);
  }

  function flush(key) {
    const e = entries.get(key);
    if (!e) return Promise.resolve();
    cancelTimer(e);
    // Behind whatever save of this key is in flight; that one may already have
    // sent this very text, which saveNow then skips.
    e.chain = e.chain.then(() => (entries.get(key) === e ? saveNow(key, e) : undefined));
    return e.chain;
  }

  return {
    edit(key, value, original) {
      let e = entries.get(key);
      if (!e) {
        e = { saved: original, latest: original, timer: null, chain: Promise.resolve() };
        entries.set(key, e);
      }
      e.latest = value;
      cancelTimer(e);
      if (value !== e.saved) e.timer = setTimer(() => { e.timer = null; flush(key); }, delay);
    },
    flush,
    flushAll() {
      return Promise.all([...entries.keys()].map(flush)).then(() => undefined);
    },
    isDirty(key) {
      const e = entries.get(key);
      return !!e && e.latest !== e.saved;
    },
    forget(key) {
      const e = entries.get(key);
      if (!e) return;
      cancelTimer(e);
      entries.delete(key);
    },
    dispose() {
      entries.forEach(cancelTimer);
    },
  };
}
