// One embed worker: card image bytes in, a milo embedding out.
//
// Runs in a worker thread (embedPool.js) because onnxruntime-node's run() is
// synchronous on the calling thread: measured 2026-11-15 (ORT 1.31), a 45 ms
// inference let the event loop tick zero times. On the main thread a whole-game
// build therefore stalled every API request ~45 ms per card for hours, and a
// second session or a concurrent run() on the same thread bought no throughput.
// Separate threads give both back: the server stays responsive, and N workers
// embed N cards at once. The model takes batch size 1 only, so this is the way
// to use more than one core.
//
// The preprocessing is the builder's, unchanged (utils/miloInput.js): catalog
// vectors and camera queries only compare if they went through the same steps.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const { SIZE, toTensorData } = require('./utils/miloInput');

// sharp's own thread pool would multiply by the number of workers; one each keeps
// the total at roughly one thread per worker, which is what the pool sized for.
sharp.concurrency(1);
sharp.cache(false);

const session = ort.InferenceSession.create(workerData.model, {
  intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
});
// Surface a model that will not load once, as a message, instead of rejecting
// every job with the same error.
session.then(
  () => parentPort.postMessage({ ready: true }),
  (err) => parentPort.postMessage({ fatal: err.message }),
);

parentPort.on('message', async ({ id, buf }) => {
  try {
    const s = await session;
    const { data } = await sharp(Buffer.from(buf)).resize(SIZE, SIZE, { fit: 'fill' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = await s.run({ image: new ort.Tensor('float32', toTensorData(data), [1, 3, SIZE, SIZE]) });
    // A copy we own outright, so its buffer can be transferred rather than cloned.
    const vec = Float32Array.from(out.embedding.data);
    parentPort.postMessage({ id, vec }, [vec.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
