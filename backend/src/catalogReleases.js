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
const { MODEL_ID } = require('./utils/miloInput');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
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
// Installed AND in the embedding space this version scans with. A catalog left
// from before a model change is not one: its vectors would match nothing.
const usable = (s) => !!s && s.model === MODEL_ID;
const isInstalled = (game, lang) => usable(readState(keyFor(game, lang)));

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
  const have = readState(key);
  const sameGeneration = have && have.generation === manifest.generation && have.model === manifest.model;
  const onDisk = new Set(sameGeneration ? have.applied || [] : []);
  const wanted = manifest.segments.filter(s => !onDisk.has(s.name));
  job.total = wanted.reduce((n, s) => n + s.bytes, 0);
  job.done = 0;

  // A new generation lands beside the old one and replaces it only when complete,
  // so a failed download leaves the catalog that was working.
  const dir = dirFor(key);
  const work = sameGeneration ? dir : `${dir}.next`;
  fs.mkdirSync(work, { recursive: true });
  let bytes = 0;
  for (const s of wanted) {
    if (!/^[\w.-]+\.seg$/.test(s.name)) throw new Error(`refusing a segment named ${s.name}`);
    job.name = s.name;
    const data = await releaseAssets.fetchAsset(s.name);
    if (data.length !== s.bytes || sha256(data) !== s.sha256) {
      throw new Error(`${s.name} does not match its manifest (${data.length} bytes) — refusing to install it`);
    }
    segments.decodeSegment(data);   // refuses anything that would not load
    const file = path.join(work, s.name);
    fs.writeFileSync(`${file}.tmp`, data);
    fs.renameSync(`${file}.tmp`, file);
    bytes += data.length;
    job.done += data.length;
  }
  if (!sameGeneration) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(work, dir);
  }
  // Files the manifest no longer names (an older generation's) go.
  const keep = new Set(manifest.segments.map(s => s.name));
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.seg') && !keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  const next = {
    key, game: manifest.game, lang: langName, model: manifest.model, dim: manifest.dim,
    generation: manifest.generation, applied: manifest.segments.map(s => s.name),
    rows: manifest.rows, bytes: manifest.segments.reduce((n, s) => n + s.bytes, 0),
    publishedAt: manifest.updatedAt, checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${statePath(key)}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${statePath(key)}.tmp`, statePath(key));
  if (wanted.length) require('./cvScan').reload(manifest.game, langName);
  return { downloaded: wanted.length, bytes };
}

// Install or update `keys` (default: every installed catalog) as one background
// job. Returns the progress record; the caller polls state().
function start(keys) {
  if (current) throw new Error('a catalog download is already running');
  const list = (keys && keys.length ? keys : installed().map(s => s.key)).filter(validKey);
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
  const keys = installed().map(s => s.key);
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
  const catalogs = ((offered && offered.catalogs) || [])
    .filter(c => games.isGame(c.game))
    .map(c => {
      const local = mine.get(c.key);
      return {
        ...c,
        installed: !!local,
        upToDate: usable(local) && local.generation === c.generation && (local.applied || []).length === c.segments,
        installedRows: local ? local.rows : null,
      };
    });
  // Installed but no longer listed (or the list could not be fetched): still shown.
  for (const [key, s] of mine) {
    if (!catalogs.some(c => c.key === key)) catalogs.push({ key, game: s.game, lang: s.lang, rows: s.rows, bytes: s.bytes, installed: true, upToDate: null });
  }
  return { catalogs, published: !!offered, error, progress: state(), last };
}

module.exports = { keyFor, installed, isInstalled, available, sync, start, state, lastResult, updateInstalled, remove, load, status, ROOT };
