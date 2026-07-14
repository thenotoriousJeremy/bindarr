// Build the FDN set index, then match a Goblin Firebomb (fdn) query against it.
const axios = require('axios');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const setIndex = require('../src/setIndex');

async function qorb(buf) {
  const { data, info } = await sharp(buf).resize({ width: 500 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(500); const kpv = new cv.KeyPointVector(); const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const kp = new Float32Array(kpv.size() * 2);
  for (let i = 0; i < kpv.size(); i++) { const p = kpv.get(i).pt; kp[i * 2] = p.x; kp[i * 2 + 1] = p.y; }
  rgba.delete(); gray.delete(); kpv.delete(); orb.delete();
  return { desc, kp };
}

(async () => {
  let t = Date.now();
  const ok = await setIndex.ensureSet('mtg', 'fdn');
  console.log('build ok:', ok, 'in', ((Date.now() - t) / 1000).toFixed(0), 's');
  const c = await axios.get('https://api.scryfall.com/cards/fdn/562');
  const raw = Buffer.from((await axios.get(c.data.image_uris.normal, { responseType: 'arraybuffer' })).data);
  const qimg = await sharp(raw).modulate({ brightness: 1.15, saturation: 1.1 }).rotate(5, { background: '#222' }).jpeg({ quality: 60 }).toBuffer();
  const q = await qorb(qimg);
  t = Date.now();
  const cands = setIndex.matchSet(q, 'mtg', 'fdn', 6);
  console.log('match', Date.now() - t, 'ms');
  cands.forEach((x, i) => console.log(`  ${i + 1}. inliers=${x.inliers} ${x.name} (${x.set} #${x.number})`));
  q.desc.delete();
  console.log(cands[0] && cands[0].name === 'Goblin Firebomb' ? 'PASS set-scoped' : 'FAIL');
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
