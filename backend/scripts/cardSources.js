// Shared card-image sources for the embedding build. Returns a flat list of
// { name, set, number, img } where img is a reasonably high-res image URL
// (better than the tiny hash images — CLIP resizes to 224 and benefits from a
// sharp downsample rather than an upscaled thumbnail).
const axios = require('axios');

function makeHttp() {
  return axios.create({
    timeout: 30000,
    headers: { 'User-Agent': 'CardDexrr/1.0', 'Accept': 'application/json' },
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// MTG: Scryfall unique_artwork bulk — one JSON file, no key.
async function gatherMtg(http) {
  console.log('Fetching Scryfall bulk-data index...');
  const bulkIndex = await http.get('https://api.scryfall.com/bulk-data');
  const entry = (bulkIndex.data.data || []).find(d => d.type === 'unique_artwork');
  if (!entry) throw new Error('unique_artwork bulk entry not found');
  console.log(`Downloading ${entry.type} (${(entry.size / 1e6).toFixed(0)} MB)...`);
  const bulkResp = await http.get(entry.download_uri, { responseType: 'json' });
  const cards = bulkResp.data;
  console.log(`Bulk contains ${cards.length} cards.`);
  const imgOf = (c) => c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal
    || c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small || null;
  return cards.filter(imgOf).map(c => ({
    name: c.name || '', set: c.set || '', number: c.collector_number || '', img: imgOf(c),
  }));
}

// Pokémon: page pokemontcg.io /cards (no bulk file). Uses POKEMON_TCG_API_KEY
// if set. Retries each page with backoff (the API is slow/flaky under load).
async function gatherPokemon(http, delay, limit) {
  const key = process.env.POKEMON_TCG_API_KEY || '';
  const headers = key ? { 'X-Api-Key': key } : {};
  if (!key) console.warn('No POKEMON_TCG_API_KEY set — paging may throttle.');
  console.log(`Paging pokemontcg.io /cards${key ? ' (with API key)' : ' (no key)'}...`);
  const out = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * 250 < total) {
    let data = null;
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && data === null; attempt++) {
      try {
        const r = await http.get('https://api.pokemontcg.io/v2/cards', {
          params: { page, pageSize: 250, select: 'id,name,number,set,images' },
          headers,
          timeout: 30000,
        });
        total = r.data.totalCount || 0;
        data = r.data.data || [];
      } catch (e) {
        if (attempt === MAX_ATTEMPTS - 1) throw e;
        console.warn(`  page ${page} attempt ${attempt + 1} failed (${e.message}); retrying...`);
        await sleep(2000 * Math.pow(2, attempt));
      }
    }
    if (data.length === 0) break;
    for (const c of data) {
      const img = c.images?.large || c.images?.small;
      if (img) out.push({ name: c.name || '', set: c.set?.id || '', number: c.number || '', img });
    }
    console.log(`  page ${page} (${out.length}/${total})`);
    if (limit && out.length >= limit) break;
    page++;
    await sleep(delay);
  }
  return out;
}

module.exports = { makeHttp, gatherMtg, gatherPokemon, sleep };
