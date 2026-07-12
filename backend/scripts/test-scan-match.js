// Quick check: embedMatch against the smoke DB. Downloads a card known to be in
// data/mtg-embed.bin (Forest blb/280), distorts it, and confirms it ranks top.
const axios = require('axios');
const sharp = require('sharp');
const embedMatch = require('../src/embedMatch');

(async () => {
  const meta = await axios.get('https://api.scryfall.com/cards/blb/280');
  const url = meta.data.image_uris.normal;
  const raw = Buffer.from((await axios.get(url, { responseType: 'arraybuffer' })).data);
  const distorted = await sharp(raw).modulate({ brightness: 1.2, saturation: 1.25 }).blur(1.0).jpeg({ quality: 60 }).toBuffer();
  const cands = await embedMatch.match(distorted, 'mtg', 8);
  console.log('Query: Forest (blb #280), distorted. Candidates:');
  cands.forEach((c, i) => console.log(`  ${i + 1}. ${c.score.toFixed(3)} ${c.name} (${c.set} #${c.number})`));
  const rank = cands.findIndex(c => c.name === 'Forest' && c.number === '280');
  console.log(`RESULT: correct ranked #${rank + 1} of ${cands.length} returned`);
})().catch(e => { console.error(e.message); process.exit(1); });
