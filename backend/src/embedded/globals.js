// The Node globals the bundled backend reads that a WebView does not define.
//
// Installed first thing by embedded/index.js, before any route module loads:
//   process       a few modules read process.env at load time; index.js fills
//                 in the settings device mode needs.
//   setImmediate  notify.emit queues its work with it (a failed price sweep
//                 reports itself that way), and without it the sweep that
//                 failed threw a second time from inside its own error report.
//                 setTimeout(0) is the same "after the current task" here.
'use strict';

function installGlobals(target = globalThis) {
  if (typeof target.process === 'undefined') target.process = { env: {} };
  if (typeof target.setImmediate !== 'function') {
    target.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
    target.clearImmediate = (handle) => clearTimeout(handle);
  }
  return target;
}

module.exports = { installGlobals };
