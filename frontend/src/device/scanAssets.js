// Scanning data on the phone, for device mode: the two models and the published
// catalogs, downloaded on request into the app's private storage.
//
// What can be downloaded is the server's own descriptor table
// (backend/src/utils/modelAssets.js, handed over by the bundled backend), so a
// size or a file name is written down once. The same rules apply as on a server:
// the models are AGPL-3.0 and Bindarr is MIT, so nothing is fetched until the
// owner asks, and every file is checked against its exact size, because a
// truncated model fails obscurely and a truncated catalog scores every card wrong.
//
// Lorcana has no published catalog (servers build theirs from card images with
// native code a phone does not have), so a phone scans Magic and Pokémon.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { loadNpz } from '../utils/npz';

const DIR = 'scan';
const HF = 'https://huggingface.co';
const at = (name) => ({ path: `${DIR}/${name}`, directory: Directory.Data });
// The previous cornelius export, which modelAssets also accepts.
const ALSO_OK = { 'cornelius.onnx': [4407545] };

let models = [];
let catalogs = [];
let present = new Set();
let busy = null;              // { name, fraction } while a download runs
let error = null;
let snapshot = null;
const listeners = new Set();

function emit() {
  snapshot = {
    models: models.map(m => ({ ...m, present: present.has(m.name) })),
    catalogs: catalogs.map(c => ({ ...c, present: present.has(c.name) })),
    modelsReady: models.length > 0 && models.every(m => present.has(m.name)),
    busy,
    error,
  };
  listeners.forEach(fn => fn());
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getSnapshot = () => snapshot;

export const modelsReady = () => models.length > 0 && models.every(m => present.has(m.name));
const catalogFor = (game) => catalogs.find(c => c.game === game);
export const catalogReady = (game) => !!catalogFor(game) && present.has(catalogFor(game).name);

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

export async function refresh() {
  const next = new Set();
  for (const a of [...models, ...catalogs]) {
    const size = await sizeOf(a.name);
    if (size === a.bytes || (ALSO_OK[a.name] || []).includes(size)) next.add(a.name);
  }
  present = next;
  emit();
}

export async function initScanAssets({ MODELS, CATALOGS }) {
  models = MODELS;
  catalogs = CATALOGS;
  await refresh();
}

async function downloadOne(asset) {
  const url = `${HF}/${asset.repo}/resolve/main/${asset.file}`;
  const part = `${asset.name}.part`;
  await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true }).catch(() => {});
  const { uri } = await Filesystem.getUri(at(part));
  const listener = await FileTransfer.addListener('progress', (p) => {
    if (p.url !== url) return;
    busy = { name: asset.name, fraction: p.lengthComputable && p.contentLength ? p.bytes / p.contentLength : null };
    emit();
  });
  try {
    await FileTransfer.downloadFile({ url, path: uri, progress: true });
  } finally {
    listener.remove();
  }
  const size = await sizeOf(part);
  if (size !== asset.bytes && !(ALSO_OK[asset.name] || []).includes(size)) {
    await Filesystem.deleteFile(at(part)).catch(() => {});
    throw new Error(`${asset.name} downloaded ${size} bytes, expected ${asset.bytes}`);
  }
  // Rename into place, so an interrupted download can never pass for a finished one.
  await Filesystem.deleteFile(at(asset.name)).catch(() => {});
  await Filesystem.rename({ from: `${DIR}/${part}`, to: `${DIR}/${asset.name}`, directory: Directory.Data, toDirectory: Directory.Data });
}

// The models (if missing) plus this game's catalog. One file at a time.
export async function downloadForGame(game) {
  if (busy) return;
  error = null;
  const wanted = [...models, catalogFor(game)].filter(a => a && !present.has(a.name));
  try {
    for (const asset of wanted) {
      busy = { name: asset.name, fraction: 0 };
      emit();
      await downloadOne(asset);
      present.add(asset.name);
    }
  } catch (err) {
    error = err.message || String(err);
    throw err;
  } finally {
    busy = null;
    emit();
  }
}

// Removing the last catalog takes the models with it: they identify nothing alone.
export async function removeGame(game) {
  const c = catalogFor(game);
  if (c) await Filesystem.deleteFile(at(c.name)).catch(() => {});
  if (!catalogs.some(x => x.game !== game && present.has(x.name))) {
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

// A catalog in the shape cvScan's device source hands back.
export async function loadCatalog(game) {
  const c = catalogFor(game);
  if (!c || !present.has(c.name)) throw new Error(`No ${game} scan catalog on this device`);
  const npz = await loadNpz(await readBytes(c.name));
  if (!npz.embeddings || npz.embeddings.error || !npz.card_ids || npz.card_ids.error) {
    throw new Error(`${c.name} is not a scan catalog`);
  }
  const [n, dim] = npz.embeddings.shape;
  return { cat: npz.embeddings.data, ids: npz.card_ids.data, n, dim };
}
