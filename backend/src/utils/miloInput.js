// What milo is fed: a 448x448 RGB square, ImageNet-normalised, planar (NCHW).
//
// One definition for the catalog builder (catalog.js) and its embed workers
// (embedWorker.js), because catalog vectors and scan queries only compare if the
// pixels went through exactly the same arithmetic. cvScan.js keeps its own copy
// for the scan side; change both together (see PROV-20 in the 1.9 review).
'use strict';

// Which embedding space a catalog's vectors live in. Bumped only if milo itself is
// replaced: a vector from one model means nothing to another, so a catalog that
// says otherwise is rebuilt or refused, never mixed.
const MODEL_ID = 'milo1';
const SIZE = 448;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Interleaved RGB bytes (SIZE*SIZE*3) -> planar normalised floats (3*SIZE*SIZE).
// Returns the raw Float32Array so callers can wrap it in whichever onnxruntime
// Tensor class they loaded; this module stays free of native dependencies.
function toTensorData(rgb) {
  const plane = SIZE * SIZE;
  const x = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return x;
}

module.exports = { MODEL_ID, SIZE, MEAN, STD, toTensorData };
