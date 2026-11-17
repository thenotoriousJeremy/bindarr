// Work a request starts and does not wait for, and work several callers share.
//
// On a server this module does nothing: start() runs the work at once, as the
// call site always did, and join() and away() hand back what they were given.
// db.js keeps every caller's statements apart with AsyncLocalStorage there.
//
// On a phone (embedded/index.js installs the device versions) a WebView has no
// async context, so the database takes turns instead (embedded/units.js): one
// request or background job at a time. Work a request left running after it
// answered would otherwise run in nobody's turn, and its transactions would open
// under whichever request held the turn next (embedded/index.js, db.withTransaction).
// So on a phone:
//
//   start(name, fn)  queues fn as a background job of its own: it runs once the
//                    request that started it has answered, in its own turn, and
//                    lets the turn go while it downloads. Fire and forget: never
//                    await it from code that holds the turn (a request, a job),
//                    which would wait for a turn it holds itself.
//   join(promise)    awaits work another caller started and may still be running
//                    — an "already in flight, share it" branch. The caller lets
//                    its turn go while it waits: the work may need that turn to
//                    finish (a job paused for a download, or between two of its
//                    transactions), and holding it would wait for ever. Only where
//                    the caller awaits the result at once.
//   away(fn)         runs fn, which does no database work (a pause, a fetch()),
//                    with a background job's turn let go. axios requests already
//                    are (embedded/index.js); this is for the rest.
//
// CommonJS with no Node API, so the server and the phone's bundle both load it.
'use strict';

let device = null;   // { start, join, away }, from embedded/index.js

function start(name, fn) {
  return device ? device.start(name, fn) : fn();
}

function join(promise) {
  return device ? device.join(promise) : promise;
}

function away(fn) {
  return device ? device.away(fn) : fn();
}

// embedded/index.js only.
function installDevice(impl) {
  device = impl;
}

module.exports = { start, join, away, installDevice };
