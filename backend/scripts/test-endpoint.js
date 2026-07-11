// End-to-end HTTP test of POST /api/scan-match against a running server on 3199
// and the smoke embedding DB. Mints a temp session token, posts a distorted
// card image, prints candidates, cleans up the token.
const db = require('../src/db');
const axios = require('axios');
const sharp = require('sharp');

(async () => {
  const u = await db.get('SELECT id FROM users LIMIT 1');
  if (!u) { console.log('no users; skip'); process.exit(0); }
  const token = 'scan_test_' + Date.now();
  await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now','+1 hour'))", [token, u.id]);
  try {
    const meta = await axios.get('https://api.scryfall.com/cards/blb/280');
    const raw = Buffer.from((await axios.get(meta.data.image_uris.normal, { responseType: 'arraybuffer' })).data);
    const dist = await sharp(raw).modulate({ brightness: 1.2, saturation: 1.2 }).blur(1).jpeg({ quality: 60 }).toBuffer();
    const image = 'data:image/jpeg;base64,' + dist.toString('base64');
    const resp = await axios.post('http://localhost:3199/api/scan-match', { game: 'mtg', image }, { headers: { Authorization: 'Bearer ' + token }, timeout: 60000 });
    console.log('HTTP', resp.status, '- candidates:');
    (resp.data.candidates || []).slice(0, 5).forEach((c, i) => console.log(`  ${i + 1}. ${c.score.toFixed(3)} ${c.name} (${c.set} #${c.number})`));
    const top = resp.data.candidates?.[0];
    console.log(top && top.name === 'Forest' ? 'PASS: Forest ranked #1' : 'CHECK: unexpected top');
  } finally {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  }
})().catch(e => { console.error('ERR', e.response?.status, e.response?.data || e.message); process.exit(1); });
