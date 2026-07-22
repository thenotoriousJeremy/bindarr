// Worker thread: verifies one slice of a set's cards against the query ORB
// features. Loads its own opencv-wasm + set index (cached per worker). The heavy
// per-card knnMatch + homography runs here, off the main event loop and across
// cores. See scanPool.js for the dispatcher.
const { parentPort } = require('worker_threads');
const setIndex = require('./setIndex');

parentPort.on('message', (msg) => {
  if (msg.type === 'extract') {
    const { id, rgba, width, height } = msg;
    try {
      const out = setIndex.extractCard(rgba, width, height);
      parentPort.postMessage({ id, out });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message || String(e) });
    }
    return;
  }
  const { id, game, set, qDesc, qRows, qKp, start, end } = msg;
  try {
    const scored = setIndex.verifySlice(game, set, qDesc, qRows, qKp, start, end);
    parentPort.postMessage({ id, scored });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message || String(e) });
  }
});
