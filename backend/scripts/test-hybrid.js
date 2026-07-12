// Test the hybrid matcher: CLIP recall (full embed DB) + ORB verify (smoke ORB
// DB containing Forest). Distorted+rotated Forest should win on inliers.
const axios = require('axios');
const sharp = require('sharp');
const scanMatch = require('../src/scanMatch');

(async () => {
  const meta = await axios.get('https://api.scryfall.com/cards/blb/280');
  const raw = Buffer.from((await axios.get(meta.data.image_uris.normal, { responseType: 'arraybuffer' })).data);
  const q = await sharp(raw).modulate({ brightness: 1.2, saturation: 1.2 }).rotate(7, { background: '#000' }).blur(0.8).jpeg({ quality: 55 }).toBuffer();
  const { verified, candidates } = await scanMatch.match(q, 'mtg', 8);
  console.log('verified:', verified);
  candidates.forEach((c, i) => console.log(`  ${i + 1}. inliers=${c.inliers} clip=${c.score.toFixed(3)} ${c.name} (${c.set} #${c.number})`));
  const top = candidates[0];
  console.log(top && top.name === 'Forest' ? 'PASS: Forest won on inliers' : 'CHECK: top not Forest');
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
