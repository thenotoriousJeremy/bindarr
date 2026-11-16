// Bindarr's own scan catalogs: built weekly by .github/workflows/scan-catalogs.yml
// and published to this repository's `scan-catalogs` release, so an install never
// has to build one and never re-downloads what it already has.
//
// Per catalog (`<game>-<lang code>`, e.g. mtg-en, pokemon-ja) the release holds:
//   <key>.json          the manifest: generation, and the segments in order
//   <key>.g<N>.<seq>.seg  one base segment, then weekly delta segments
//   catalogs.json       every catalog's summary, for the Admin list
//
// Installing downloads every segment of the current generation; an update fetches
// the manifest (one small request) and only the segments not yet on disk — a new
// set's worth of cards is ~0.1-0.3 MB where the whole Magic catalog is ~30 MB. A
// new generation (the build folds deltas into a fresh base every few months)
// downloads the new base once. Every segment is checked against the manifest's
// SHA-256 before it is kept. Segments stay on disk as published and are applied
// when the scanner loads (utils/catalogSegments).
//
// Rows are keyed by Bindarr card ids, like a catalog built here: every match
// resolves to a card, and a catalog built locally for the same game merges with
// it (cvScan.load).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const releaseAssets = require('./utils/releaseAssets');
const segments = require('./utils/catalogSegments');
const languages = require('./utils/languages');
const games = require('./utils/games');
// Where the models and catalogs live, and which embedding space this version
// scans in: both defined once, in modelAssets.
const { MODEL_DIR, MODEL_ID } = require('./utils/modelAssets');
const ROOT = path.join(MODEL_DIR, 'bindarr');
const keyFor = (game, lang) => `${game}-${languages.toCode(lang || 'English')}`;
const dirFor = (key) => path.join(ROOT, key);
const statePath = (key) => path.join(dirFor(key), 'state.json');
const validKey = (key) => /^[a-z0-9]+-[a-z]{2}(?:-[a-z]{2})?$/.test(String(key || ''));

function readState(key) {
  try { return JSON.parse(fs.readFileSync(statePath(key), 'utf8')); } catch { return null; }
}

// Installed catalogs, as their state files say.
function installed() {
  let names = [];
  try { names = fs.readdirSync(ROOT); } catch { return []; }
  return names.filter(validKey).map(readState).filter(Boolean);
}
// Installed, in the embedding space this version scans with (a catalog left from
// before a model change would match nothing), and not switched off: a Pokémon
// catalog is keyed by TCGdex's card ids, so it answers only while TCGdex is the
// install's Pokémon provider (applyProvider). On a pokemontcg.io or
// pokemontcgapi.com install its matches would file TCGdex-numbered cards beside
// the install's own — exactly what the provider pin exists to prevent.
const usable = (s) => !!s && s.model === MODEL_ID && !s.disabled;
const isInstalled = (game, lang) => usable(readState(keyFor(game, lang)));

// Whether a catalog of `game` in `lang` fits this install's card ids. Only
// Pokémon depends on a setting.
async function fitsInstall(game, lang) {
  if (game !== 'pokemon') return true;
  return require('./utils/pokemonProvider').usesTcgdex(lang);
}

function writeState(key, next, dir = dirFor(key)) {
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

// After the Pokémon provider changes (routes/settings.js, the provider migration,
// and at startup): each installed Pokémon catalog is switched on or off to match,
// and the scanner reloads what changed. Never throws.
async function applyProvider() {
  for (const st of installed()) {
    if (st.game !== 'pokemon') continue;
    try {
      const off = !(await fitsInstall(st.game, st.lang));
      if (!!st.disabled === off) continue;
      writeState(st.key, { ...st, disabled: off });
      require('./cvScan').reload(st.game, st.lang);
      console.log(`Scan catalog ${st.key}: ${off ? 'off — this install no longer uses TCGdex for Pokémon' : 'back on'}`);
    } catch (e) {
      console.warn(`Scan catalog ${st.key}: could not apply the Pokémon provider: ${e.message}`);
    }
  }
}

// What the release offers, cached for ten minutes: the Admin panel polls.
let indexCache = null;
async function available({ fresh = false } = {}) {
  if (!fresh && indexCache && Date.now() - indexCache.at < 10 * 60 * 1000) return indexCache.value;
  const value = await releaseAssets.fetchJson('catalogs.json');
  indexCache = { at: Date.now(), value };
  return value;
}

// One download or update at a time, mirroring modelAssets: these are tens of
// megabytes, and two at once help nobody.
let current = null;
let last = null;
const state = () => (current ? { ...current } : null);
const lastResult = () => last;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Bring one catalog up to its published manifest. Returns { downloaded, bytes }.
async function sync(key, job = {}) {
  if (!validKey(key)) throw new Error(`not a catalog: ${key}`);
  const manifest = await releaseAssets.fetchJson(`${key}.json`);
  if (!manifest || !Array.isArray(manifest.segments) || !manifest.segments.length) {
    throw new Error(`${key} is not published`);
  }
  if (manifest.model !== MODEL_ID) {
    throw new Error(`${key} is built for scan model ${manifest.model}, and this version of Bindarr scans with ${MODEL_ID} — update Bindarr to use it`);
  }
  const langName = languages.toName(manifest.lang) || 'English';
  if (!(await fitsInstall(manifest.game, langName))) {
    throw new Error(`${key} names cards by TCGdex id, and this install takes its Pokémon cards from another provider — `
      + 'the model author\'s catalog (or a catalog built here) is the one to use');
  }
  const have = readState(key);
  const sameGeneration = have && have.generation === manifest.generation && have.model === manifest.model;
  const dir = dirFor(key);
  // A segment the state names but the disk lacks, or holds at the wrong size (a
  // file deleted or truncated since), is downloaded again.
  const intact = (name) => {
    const want = manifest.segments.find(x => x.name === name);
    try { return !!want && fs.statSync(path.join(dir, name)).size === want.bytes; } catch { return false; }
  };
  const onDisk = new Set(sameGeneration ? (have.applied || []).filter(intact) : []);
  const wanted = manifest.segments.filter(x => !onDisk.has(x.name));
  job.total = wanted.reduce((n, x) => n + x.bytes, 0);
  job.done = 0;

  // A new generation lands beside the old one and replaces it only when complete,
  // so a failed download leaves the catalog that was working. Its folder starts
  // empty: what an earlier failed attempt left there is not trusted.
  const work = sameGeneration ? dir : `${dir}.next`;
  if (!sameGeneration) fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  let bytes = 0;
  try {
    for (const x of wanted) {
      if (!/^[\w.-]+\.seg$/.test(x.name)) throw new Error(`refusing a segment named ${x.name}`);
      job.name = x.name;
      const data = await releaseAssets.fetchAsset(x.name, { maxBytes: x.bytes });
      if (data.length !== x.bytes || sha256(data) !== x.sha256) {
        throw new Error(`${x.name} does not match its manifest (${data.length} bytes) — refusing to install it`);
      }
      segments.decodeSegment(data);   // refuses anything that would not load
      const file = path.join(work, x.name);
      fs.writeFileSync(`${file}.tmp`, data);
      fs.renameSync(`${file}.tmp`, file);
      bytes += data.length;
      job.done += data.length;
    }
  } catch (e) {
    if (!sameGeneration) fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
  const next = {
    key, game: manifest.game, lang: langName, model: manifest.model, dim: manifest.dim,
    generation: manifest.generation, applied: manifest.segments.map(x => x.name),
    rows: manifest.rows, bytes: manifest.segments.reduce((n, x) => n + x.bytes, 0),
    publishedAt: manifest.updatedAt, checkedAt: new Date().toISOString(),
    ...(manifest.game === 'pokemon' ? { provider: 'tcgdex' } : {}),
  };
  if (!sameGeneration) {
    // The state goes in with the segments, so the swap below is the one step that
    // changes which catalog answers: a crash on either side of it leaves a whole one.
    writeState(key, next, work);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(work, dir);
  } else {
    writeState(key, next);
  }
  // Files the manifest no longer names (an older generation's) go.
  const keep = new Set(manifest.segments.map(x => x.name));
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.seg') && !keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  if (wanted.length) require('./cvScan').reload(manifest.game, langName);
  return { downloaded: wanted.length, bytes };
}

// Install or update `keys` (default: every installed catalog) as one background
// job. Returns the progress record; the caller polls state().
function start(keys) {
  if (current) throw new Error('a catalog download is already running');
  const list = (keys && keys.length ? keys : installed().filter(s => !s.disabled).map(s => s.key)).filter(validKey);
  if (!list.length) throw new Error('no catalog to download');
  const job = { keys: list, key: list[0], name: '', done: 0, total: 0, phase: 'downloading', message: '' };
  current = job;
  (async () => {
    let downloaded = 0, bytes = 0;
    const failed = [];
    for (const key of list) {
      job.key = key;
      try {
        const r = await sync(key, job);
        downloaded += r.downloaded;
        bytes += r.bytes;
      } catch (e) {
        failed.push(`${key}: ${e.message}`);
        console.warn(`scan catalog ${key}: ${e.message}`);
      }
    }
    job.downloaded = downloaded;
    job.bytes = bytes;
    job.phase = failed.length && !downloaded ? 'error' : 'done';
    job.message = failed.length
      ? `${failed.join('; ')}${downloaded ? `; ${downloaded} file(s) downloaded otherwise` : ''}`
      : `${downloaded} file(s), ${(bytes / 1048576).toFixed(1)} MB`;
    last = { ...job, finishedAt: Date.now() };
    current = null;
  })();
  return state();
}

// The weekly check: every installed catalog against its manifest. Never throws.
async function updateInstalled() {
  if (current) return { skipped: 'busy' };
  // A catalog switched off (a Pokémon one off TCGdex) is not updated: sync would refuse it.
  const keys = installed().filter(s => !s.disabled).map(s => s.key);
  if (!keys.length) return { skipped: 'none installed' };
  try {
    start(keys);
  } catch (e) {
    return { skipped: e.message };
  }
  while (current) await new Promise(r => setTimeout(r, 500));
  return last;
}

function remove(key) {
  if (!validKey(key)) throw new Error(`not a catalog: ${key}`);
  const s = readState(key);
  fs.rmSync(dirFor(key), { recursive: true, force: true });
  if (s) require('./cvScan').reload(s.game, s.lang);
  return !!s;
}

// The catalog for (game, lang) as the scanner sweeps it: { ids, cat, dim, n }, or
// null when none is installed. Segments are applied in manifest order.
function load(game, lang) {
  const key = keyFor(game, lang);
  const s = readState(key);
  if (!usable(s)) return null;
  const decoded = s.applied.map(name => segments.decodeSegment(fs.readFileSync(path.join(dirFor(key), name))));
  const { ids, cat, dim, rows } = segments.applySegments(decoded);
  return { ids, cat, dim, n: rows, generation: s.generation };
}

// Summary for Admin: what is installed, and what the release offers for the
// games this install knows.
async function status({ fresh = false } = {}) {
  let offered = null;
  let error = null;
  try {
    offered = await available({ fresh });
  } catch (e) {
    error = e.message;
  }
  const mine = new Map(installed().map(s => [s.key, s]));
  const fits = new Map();
  for (const c of (offered && offered.catalogs) || []) {
    if (!fits.has(`${c.game}|${c.lang}`)) fits.set(`${c.game}|${c.lang}`, await fitsInstall(c.game, c.lang).catch(() => false));
  }
  const catalogs = ((offered && offered.catalogs) || [])
    .filter(c => games.isGame(c.game))
    // A catalog that does not fit this install's card ids is not offered (a
    // Pokémon one off TCGdex); one installed before the provider changed still
    // shows, switched off, so it can be removed.
    .filter(c => fits.get(`${c.game}|${c.lang}`) || mine.has(c.key))
    .map(c => {
      const local = mine.get(c.key);
      return {
        ...c,
        installed: !!local,
        disabled: !!(local && local.disabled),
        upToDate: usable(local) && local.generation === c.generation && (local.applied || []).length === c.segments,
        installedRows: local ? local.rows : null,
      };
    });
  // Installed but no longer listed (or the list could not be fetched): still shown.
  for (const [key, s] of mine) {
    if (!catalogs.some(c => c.key === key)) catalogs.push({ key, game: s.game, lang: s.lang, rows: s.rows, bytes: s.bytes, installed: true, disabled: !!s.disabled, upToDate: null });
  }
  return { catalogs, published: !!offered, error, progress: state(), last };
}

module.exports = { keyFor, installed, isInstalled, available, sync, start, state, lastResult, updateInstalled, remove, load, status, applyProvider, fitsInstall, ROOT };
