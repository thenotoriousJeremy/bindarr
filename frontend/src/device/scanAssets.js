// Scanning data on the phone, for device mode: the two models and a catalog per
// game, downloaded on request into the app's private storage.
//
// A game's catalog comes from Bindarr's own `scan-catalogs` release when one is
// published for it (backend/src/catalogReleases.js has the format): downloaded
// once, then only each week's delta, and keyed by card ids so every match names a
// card. Otherwise it is the model author's dated snapshot (.npz), as before.
//
// What can be downloaded is the server's own descriptor table
// (backend/src/utils/modelAssets.js, handed over by the bundled backend), so a
// size or a file name is written down once. The same rules apply as on a server:
// the models are AGPL-3.0 and Bindarr is MIT, so nothing is fetched until the
// owner asks, and every file is checked against its exact size and SHA-256,
// because a truncated model fails obscurely and a truncated catalog scores every
// card wrong.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { loadNpz } from '../utils/npz';
import { wasmSimdSupported, NO_SIMD_MESSAGE } from './wasmSupport';

const DIR = 'scan';
const HF = 'https://huggingface.co';
// Kept out of the phone's backups (MOB-12). Everything here can be downloaded
// again, and it is big enough to crowd out what cannot: on iOS, Directory.Data is
// Documents, which goes to iCloud (~77 MB of it), so the files live in
// Library/NoCloud instead. Android maps both to the app's files directory, and
// the app's backup rules leave scan/ out there (android/app/src/main/res/xml/
// backup_rules.xml and data_extraction_rules.xml) so the 25 MB backup quota
// keeps room for the collection database.
const HOME = Directory.LibraryNoCloud;
// Where Bindarr 1.9.0 downloaded them; moved out on the next launch.
const OLD_HOME = Directory.Data;
const at = (name, directory = HOME) => ({ path: `${DIR}/${name}`, directory });
// The previous cornelius export, which modelAssets also accepts.
const ALSO_OK = { 'cornelius.onnx': [4407545] };
// A phone keeps each game's English catalog: the artwork is the same in every
// language, and the scan route re-expresses a match in the language scanned.
const keyFor = (game) => `${game}-en`;
const stateName = (game) => `bindarr-${keyFor(game)}.json`;
const STATE_RE = /^bindarr-([a-z0-9]+)-en\.json$/;
// Installed release catalogs ask for their manifest at most this often.
const RECHECK_MS = 24 * 60 * 60 * 1000;

let models = [];
let snapshots = [];           // the model author's .npz catalogs
let release = null;           // { base, segments, model } from the bundled backend
let index = null;             // the release's catalogs.json, once fetched
let installed = new Map();    // game -> the state of its release catalog here
// Games whose release catalog does not fit this phone's card ids: Pokémon when the
// phone takes its Pokémon cards from another provider than TCGdex (release.fits).
let unfit = new Set();
let present = new Set();      // model and .npz files on disk at their exact size
let busy = null;              // { name, fraction } while a download runs
let error = null;
// False where the scan models cannot run at all (no WebAssembly SIMD).
let supported = true;
let snapshot = null;
const listeners = new Set();

const snapshotFor = (game) => snapshots.find(c => c.game === game);
const offered = (game) => (index ? index.catalogs.find(c => c.game === game && c.lang === 'English') : null);

// One row per game a phone can scan: a release catalog where there is one,
// otherwise the snapshot.
function catalogList() {
  const games = new Set([
    ...snapshots.map(c => c.game),
    ...(index ? index.catalogs.filter(c => c.lang === 'English').map(c => c.game) : []),
    ...installed.keys(),
  ]);
  return [...games].map((game) => {
    const npz = snapshotFor(game) || null;
    const rel = unfit.has(game) ? null : offered(game);
    const mine = unfit.has(game) ? null : installed.get(game) || null;
    return {
      game,
      name: npz ? npz.name : null,
      bytes: rel ? rel.bytes : npz ? npz.bytes : 0,
      snapshot: rel || mine ? null : npz ? npz.snapshot : null,
      updatedAt: mine ? mine.updatedAt : rel ? rel.updatedAt : null,
      release: !!(rel || mine),
      present: !!mine || (!!npz && present.has(npz.name)),
    };
  });
}

function emit() {
  snapshot = {
    models: models.map(m => ({ ...m, present: present.has(m.name) })),
    catalogs: catalogList(),
    modelsReady: models.length > 0 && models.every(m => present.has(m.name)),
    busy,
    error,
    supported,
  };
  listeners.forEach(fn => fn());
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getSnapshot = () => snapshot;

export const modelsReady = () => models.length > 0 && models.every(m => present.has(m.name));
const releaseReady = (game) => installed.has(game) && !unfit.has(game);
export const catalogReady = (game) => releaseReady(game) || (!!snapshotFor(game) && present.has(snapshotFor(game).name));
// True when the game scans from a release catalog (keyed by card ids, so no
// product map is needed to name a match).
export const isReleaseCatalog = (game) => releaseReady(game);

async function sizeOf(name) {
  try {
    // The plugin's web build (the browser dev harness only) keeps files as base64
    // and reports that length, a third over the real size; count the bytes instead.
    if (!Capacitor.isNativePlatform()) return (await readBytes(name)).length;
    return (await Filesystem.stat(at(name))).size;
  } catch {
    return -1;
  }
}

async function readState(game) {
  try {
    const { data } = await Filesystem.readFile({ ...at(stateName(game)), encoding: Encoding.UTF8 });
    const s = JSON.parse(typeof data === 'string' ? data : await data.text());
    return s && Array.isArray(s.segments) && s.model === (release && release.model) ? s : null;
  } catch {
    return null;
  }
}

export async function refresh() {
  const next = new Set();
  for (const a of [...models, ...snapshots]) {
    const size = await sizeOf(a.name);
    if (size === a.bytes || (ALSO_OK[a.name] || []).includes(size)) next.add(a.name);
  }
  present = next;
  // A release catalog counts only with every segment on disk at its size.
  const mine = new Map();
  let files = [];
  try {
    files = (await Filesystem.readdir({ path: DIR, directory: HOME })).files.map(f => (typeof f === 'string' ? f : f.name));
  } catch { /* nothing downloaded yet */ }
  for (const f of files) {
    const m = STATE_RE.exec(f);
    if (!m) continue;
    const s = await readState(m[1]);
    if (!s) continue;
    let whole = true;
    for (const seg of s.segments) {
      if (await sizeOf(seg.name) !== seg.bytes) { whole = false; break; }
    }
    if (whole) mine.set(m[1], s);
  }
  installed = mine;
  emit();
}

// Scan data an earlier version downloaded into OLD_HOME: moved to HOME once. A
// file that will not move is deleted instead (it can be downloaded again, and
// left where it is it would stay in the backup); the scan tab then simply offers
// the download again. Where the two directories are the same folder (Android),
// there is nothing to do.
async function moveFromOldHome(names) {
  let from;
  let to;
  try {
    from = (await Filesystem.getUri({ path: DIR, directory: OLD_HOME })).uri;
    to = (await Filesystem.getUri({ path: DIR, directory: HOME })).uri;
  } catch {
    return;
  }
  if (from === to) return;
  const old = await Filesystem.readdir({ path: DIR, directory: OLD_HOME }).catch(() => null);
  if (!old || !old.files || !old.files.length) return;
  await Filesystem.mkdir({ path: DIR, directory: HOME, recursive: true }).catch(() => {});
  for (const entry of old.files) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!names.includes(name)) continue;   // a .part left by an interrupted download
    try {
      await Filesystem.rename({ from: `${DIR}/${name}`, to: `${DIR}/${name}`, directory: OLD_HOME, toDirectory: HOME });
    } catch (err) {
      console.warn(`Scan data: could not move ${name} out of the backed-up folder; it will be downloaded again.`, err);
    }
  }
  await Filesystem.rmdir({ path: DIR, directory: OLD_HOME, recursive: true }).catch(() => {});
}

// What the release offers, for sizes and dates before anything is downloaded.
// Asked for by the scan-setup screen when it opens (DeviceScanSetup), never at
// launch: nothing goes to GitHub until the owner looks at scanning. Once is enough
// per launch.
let indexAsked = false;
export async function loadReleaseIndex() {
  if (!release || !supported || indexAsked) return;
  indexAsked = true;
  try {
    const res = await fetch(`${release.base}/catalogs.json`, { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    if (j && Array.isArray(j.catalogs)) {
      index = { ...j, catalogs: j.catalogs.filter(c => c.model === release.model) };
      emit();
    }
  } catch { indexAsked = false; /* the snapshots are still offered; asked again next time */ }
}

// Which release catalogs fit this phone (release.fits, from the bundled backend).
async function checkFit() {
  const next = new Set();
  if (release && release.fits) {
    for (const game of new Set([...snapshots.map(c => c.game), ...installed.keys(), 'pokemon'])) {
      if (!(await release.fits(game).catch(() => true))) next.add(game);
    }
  }
  unfit = next;
}

export async function initScanAssets({ MODELS, CATALOGS, release: rel }) {
  models = MODELS;
  snapshots = CATALOGS;
  release = rel || null;
  supported = wasmSimdSupported();
  if (!supported) error = NO_SIMD_MESSAGE;
  await moveFromOldHome([...MODELS, ...CATALOGS].map(a => a.name)).catch(err => console.warn('Scan data move failed:', err));
  await refresh();
  await checkFit();
  emit();
}

// The descriptors come from modelAssets.js, which pins each file to one Hugging
// Face commit and records its SHA-256, and a release manifest records each
// segment's. The phone checks the same hash, so it never scans with a file the
// server would refuse.
async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// One file to DIR/name through the native downloader, checked against its size
// and SHA-256, then renamed into place, so an interrupted download can never pass
// for a finished one. Resolves to the bytes it hashed, or null when it could not.
async function downloadTo(url, name, bytes, { sha256 = null, acceptSizes = [] } = {}) {
  const part = `${name}.part`;
  await Filesystem.mkdir({ path: DIR, directory: HOME, recursive: true }).catch(() => {});
  const { uri } = await Filesystem.getUri(at(part));
  const listener = await FileTransfer.addListener('progress', (p) => {
    if (p.url !== url) return;
    busy = { name, fraction: p.lengthComputable && p.contentLength ? p.bytes / p.contentLength : null };
    emit();
  });
  try {
    await FileTransfer.downloadFile({ url, path: uri, progress: true });
  } finally {
    listener.remove();
  }
  const size = await sizeOf(part);
  if (size !== bytes && !acceptSizes.includes(size)) {
    await Filesystem.deleteFile(at(part)).catch(() => {});
    throw new Error(`${name} downloaded ${size} bytes, expected ${bytes}`);
  }
  let data = null;
  if (sha256 && globalThis.crypto?.subtle) {
    data = await readBytes(part);
    const digest = await sha256Hex(data);
    if (digest !== sha256) {
      await Filesystem.deleteFile(at(part)).catch(() => {});
      throw new Error(`${name} has SHA-256 ${digest}, expected ${sha256}`);
    }
  }
  await Filesystem.deleteFile(at(name)).catch(() => {});
  await Filesystem.rename({ from: `${DIR}/${part}`, to: `${DIR}/${name}`, directory: HOME, toDirectory: HOME });
  return data;
}

// A model or a snapshot, from the commit the server's list pins (utils/modelAssets),
// so a phone and a server always fetch the same file.
function downloadAsset(asset) {
  const url = `${HF}/${asset.repo}/resolve/${asset.revision || 'main'}/${asset.file}`;
  return downloadTo(url, asset.name, asset.bytes, { sha256: asset.sha256, acceptSizes: ALSO_OK[asset.name] || [] });
}

// Bring the game's release catalog up to its manifest: the segments this phone
// lacks, then the state that names them, then the files the manifest dropped.
// A new generation downloads beside the old one, which keeps answering until the
// new state is written. False when the release has no catalog for the game.
async function syncRelease(game) {
  if (!release || unfit.has(game)) return false;
  // A segment's SHA-256 is what stands between a bad download and a catalog that
  // scores every card wrong: without WebCrypto to check it, nothing is installed.
  if (!globalThis.crypto?.subtle) throw new Error('this WebView cannot verify downloads (no WebCrypto)');
  const key = keyFor(game);
  const res = await fetch(`${release.base}/${key}.json`, { cache: 'no-store' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${key}.json: HTTP ${res.status}`);
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.segments) || !manifest.segments.length) return false;
  if (manifest.model !== release.model) throw new Error(`${key} is built for another scan model; update the app to use it`);
  const have = installed.get(game);
  const onDisk = new Set(have && have.generation === manifest.generation ? have.segments.map(s => s.name) : []);
  for (const s of manifest.segments) {
    if (onDisk.has(s.name)) continue;
    if (!/^[\w.-]+\.seg$/.test(s.name)) throw new Error(`refusing a segment named ${s.name}`);
    busy = { name: s.name, fraction: 0 };
    emit();
    const data = await downloadTo(`${release.base}/${s.name}`, s.name, s.bytes, { sha256: s.sha256 });
    if (!data) throw new Error(`${s.name} could not be verified`);
    release.segments.decodeSegment(data);   // refuses anything that would not load
  }
  const state = {
    key, game, generation: manifest.generation, model: manifest.model, rows: manifest.rows,
    updatedAt: manifest.updatedAt, checkedAt: Date.now(),
    segments: manifest.segments.map(s => ({ name: s.name, bytes: s.bytes })),
  };
  await Filesystem.writeFile({ ...at(stateName(game)), data: JSON.stringify(state), encoding: Encoding.UTF8 });
  installed.set(game, state);
  const keep = new Set(state.segments.map(s => s.name));
  for (const old of have ? have.segments : []) {
    if (!keep.has(old.name)) await Filesystem.deleteFile(at(old.name)).catch(() => {});
  }
  return true;
}

// The models (if missing) plus this game's catalog. One file at a time.
export async function downloadForGame(game) {
  if (busy) return;
  // Not ~70 MB for models this phone cannot run (MOB-04).
  if (!supported) {
    error = NO_SIMD_MESSAGE;
    emit();
    throw Object.assign(new Error(NO_SIMD_MESSAGE), { code: 'noWasmSimd' });
  }
  error = null;
  await checkFit();
  try {
    for (const m of models.filter(a => !present.has(a.name))) {
      busy = { name: m.name, fraction: 0 };
      emit();
      await downloadAsset(m);
      present.add(m.name);
    }
    let fromRelease = false;
    try {
      fromRelease = await syncRelease(game);
    } catch (err) {
      // The snapshot still scans; without one there is nothing else to offer.
      if (!snapshotFor(game)) throw err;
      console.warn(`Bindarr's ${game} catalog could not be downloaded (${err.message}); using the snapshot`);
    }
    const npz = snapshotFor(game);
    if (fromRelease) {
      // Superseded: the release catalog covers every card the snapshot did.
      if (npz && present.has(npz.name)) {
        await Filesystem.deleteFile(at(npz.name)).catch(() => {});
        present.delete(npz.name);
      }
    } else {
      if (!npz) throw new Error(`No scan catalog is published for ${game}`);
      if (!present.has(npz.name)) {
        busy = { name: npz.name, fraction: 0 };
        emit();
        await downloadAsset(npz);
        present.add(npz.name);
      }
    }
  } catch (err) {
    error = err.message || String(err);
    throw err;
  } finally {
    busy = null;
    emit();
  }
}

// The daily check: each installed release catalog against its manifest, fetching
// only what is new. Resolves true when anything changed (the caller then reloads
// the scanner). Quiet on failure: scanning keeps the catalog it has.
export async function updateReleases({ force = false } = {}) {
  if (busy || !release || !supported) return false;
  await checkFit();
  let changed = false;
  for (const [game, s] of [...installed]) {
    if (unfit.has(game)) continue;
    if (!force && Date.now() - (s.checkedAt || 0) < RECHECK_MS) continue;
    try {
      const before = s.segments.map(x => x.name).join();
      await syncRelease(game);
      if (installed.get(game).segments.map(x => x.name).join() !== before) changed = true;
    } catch (err) {
      console.warn(`Scan catalog update for ${game} failed: ${err.message}`);
    } finally {
      busy = null;
      emit();
    }
  }
  return changed;
}

// Removing the last catalog takes the models with it: they identify nothing alone.
export async function removeGame(game) {
  const mine = installed.get(game);
  if (mine) {
    for (const s of mine.segments) await Filesystem.deleteFile(at(s.name)).catch(() => {});
    await Filesystem.deleteFile(at(stateName(game))).catch(() => {});
    installed.delete(game);
  }
  const c = snapshotFor(game);
  if (c) await Filesystem.deleteFile(at(c.name)).catch(() => {});
  const others = installed.size > 0 || snapshots.some(x => x.game !== game && present.has(x.name));
  if (!others) {
    for (const m of models) await Filesystem.deleteFile(at(m.name)).catch(() => {});
  }
  await refresh();
}

// The bytes of a downloaded file. In the app the WebView reads the file straight
// off disk through its local server; going through Filesystem.readFile instead
// would carry a 56 MB catalog across the bridge as base64.
export async function readBytes(name) {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.getUri(at(name));
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const { data } = await Filesystem.readFile(at(name));
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}

// A catalog in the shape cvScan's device source hands back. `local` says the ids
// are card ids (a release catalog) rather than the snapshot's provider ids.
export async function loadCatalog(game) {
  const mine = releaseReady(game) ? installed.get(game) : null;
  if (mine) {
    const decoded = [];
    for (const s of mine.segments) decoded.push(release.segments.decodeSegment(await readBytes(s.name)));
    const { ids, cat, dim, rows } = release.segments.applySegments(decoded);
    return { cat, ids, n: rows, dim, local: true };
  }
  const c = snapshotFor(game);
  if (!c || !present.has(c.name)) throw new Error(`No ${game} scan catalog on this device`);
  const npz = await loadNpz(await readBytes(c.name));
  if (!npz.embeddings || npz.embeddings.error || !npz.card_ids || npz.card_ids.error) {
    throw new Error(`${c.name} is not a scan catalog`);
  }
  const [n, dim] = npz.embeddings.shape;
  return { cat: npz.embeddings.data, ids: npz.card_ids.data, n, dim, local: false };
}
