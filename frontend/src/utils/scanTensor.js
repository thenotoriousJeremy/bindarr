// Pixels -> model input, exactly as the server builds it (backend/src/cvScan.js
// toTensor): planar RGB, ImageNet mean/std. Takes canvas RGBA, which is what a
// browser has; the alpha byte is skipped. Kept pure and separate from the engine
// so the arithmetic can be checked without onnxruntime (scanTensor.test.js).

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function rgbaToChw(rgba, size) {
  const plane = size * size;
  const x = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    x[p] = (rgba[p * 4] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgba[p * 4 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgba[p * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return x;
}
