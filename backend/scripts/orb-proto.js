// Feasibility prototype: does ORB + RANSAC homography cleanly separate the same
// card (distorted) from a different card? Prints inlier counts.
const { cv } = require('opencv-wasm');
const axios = require('axios');
const sharp = require('sharp');

function ready() {
  return new Promise((res) => {
    if (cv && cv.Mat) return res();
    if (typeof cv.then === 'function') return cv.then(() => res());
    cv.onRuntimeInitialized = () => res();
  });
}

async function grayMat(buf) {
  const { data, info } = await sharp(buf).resize({ width: 500, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

function orbFeatures(orb, gray) {
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kp, desc);
  return { kp, desc };
}

// Ratio-tested matches -> RANSAC homography inlier count.
function inliers(a, b) {
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(a.desc, b.desc, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() < 2) continue;
    const m0 = m.get(0), m1 = m.get(1);
    if (m0.distance < 0.75 * m1.distance) {
      const pa = a.kp.get(m0.queryIdx).pt, pb = b.kp.get(m0.trainIdx).pt;
      src.push(pa.x, pa.y); dst.push(pb.x, pb.y);
    }
  }
  const good = src.length / 2;
  if (good < 4) { bf.delete(); knn.delete(); return { good, inl: 0 }; }
  const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(srcM, dstM, cv.RANSAC, 5.0, mask);
  const inl = cv.countNonZero(mask);
  srcM.delete(); dstM.delete(); mask.delete(); H.delete(); bf.delete(); knn.delete();
  return { good, inl };
}

(async () => {
  await ready();
  console.log('OpenCV ready.');
  const get = async (u) => Buffer.from((await axios.get(u, { responseType: 'arraybuffer' })).data);
  const forest = await axios.get('https://api.scryfall.com/cards/blb/280');
  const bolt = await axios.get('https://api.scryfall.com/cards/2x2/117'); // Lightning Bolt (different)
  const fBuf = await get(forest.data.image_uris.normal);
  const bBuf = await get(bolt.data.image_uris.normal);
  const query = await sharp(fBuf).modulate({ brightness: 1.2, saturation: 1.2 }).rotate(6, { background: '#000' }).blur(0.8).jpeg({ quality: 55 }).toBuffer();

  const orb = new cv.ORB(700);
  const gq = await grayMat(query), gf = await grayMat(fBuf), gb = await grayMat(bBuf);
  const fq = orbFeatures(orb, gq), ff = orbFeatures(orb, gf), fb = orbFeatures(orb, gb);

  const same = inliers(fq, ff);
  const diff = inliers(fq, fb);
  console.log(`query=Forest(distorted+rotated)`);
  console.log(`  vs Forest (same):     good=${same.good} inliers=${same.inl}`);
  console.log(`  vs Lightning Bolt:    good=${diff.good} inliers=${diff.inl}`);
  console.log(same.inl >= 12 && same.inl > diff.inl * 2 ? 'PASS: strong separation' : 'WEAK: check params');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
