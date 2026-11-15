// Build one of Bindarr's scan catalogs, and the files that publish it to this
// repository's `scan-catalogs` release (.github/workflows/scan-catalogs.yml).
//
//   node scripts/scan-catalogs/build.mjs --key pokemon-en --out <dir>
//   node scripts/scan-catalogs/build.mjs --index --assets <names.txt> --manifests <dir> --out <dir>
//
// A build restores last week's catalog from the release (its segments, and the
// image url every row was embedded from), caches every set from the providers into
// a throwaway database, embeds only the cards that are new or whose art changed
// (catalog.js: artKey resume), and publishes the difference as ONE delta segment.
// Installs then download that delta and nothing else (backend/src/catalogReleases.js).
// After MAX_DELTAS deltas, or once the deltas add up to REBASE_SHARE of the
// catalog, it writes a fresh base under the next generation instead, so a new
// install never has to walk a long chain and old rows stop costing bytes.
//
// Files written to --out:
//   <key>.g<generation>.<seq>.seg    the new segment (none when nothing changed)
//   <key>.state.json.gz              each row's image url, for next week's resume
//   pokemon-tcgplayer.<code>.json    Pokémon: the TCGplayer groups TCGdex lacks
//   <key>.json                       the manifest, which installs read first
//   publish.json                     { upload: [...], manifest } for the workflow:
//                                    `upload` first, the manifest last, so no
//                                    install ever reads a manifest naming a
//                                    segment that is not up yet
//
// --index reads the manifests (downloaded with `gh`, which is never stale) and
// writes catalogs.json, the list the Admin panel offers, plus delete.txt: segments
// of generations no manifest uses any more.
//
// Options: --rebase (force a new base), --fresh (re-embed every card), --sets a,b
// (only these sets: for trying the script locally; the result is not publishable),
// --allow-removals (publish even if many cards disappeared upstream).
//
// Environment: CV_MODEL_DIR must hold milo.onnx (backend/scripts/fetch-models.mjs);
// CATALOG_RELEASE_URL overrides where the previous build is read from. The database
// is a temporary file; nothing here touches a real install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const backend = createRequire(path.join(ROOT, 'backend', 'package.json'));

const MAX_DELTAS = 26;        // about six months of weekly changes
const REBASE_SHARE = 0.25;    // deltas holding a quarter of the catalog: start over
// A build that loses more than this share of last week's rows is a provider
// outage, not a week of removed cards. Publishing it would delete those cards
// from every install's scanner; failing the job keeps last week's catalog.
const MAX_REMOVED_SHARE = 0.03;
const KEY_RE = /^([a-z0-9]+)-([a-z]{2}(?:-[a-z]{2})?)$/;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i++; }
  }
  return out;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

function summary(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
  }
}

// --- index ---------------------------------------------------------------------

function index(args) {
  const out = path.resolve(args.out || '.');
  fs.mkdirSync(out, { recursive: true });
  const names = fs.readFileSync(args.assets, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const catalogs = [];
  const current = new Map();   // key -> generation its manifest is on
  for (const name of names) {
    if (!name.endsWith('.json') || !KEY_RE.test(name.slice(0, -5))) continue;
    const file = path.join(args.manifests, name);
    if (!fs.existsSync(file)) throw new Error(`${name} is listed but was not downloaded`);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.set(m.key, m.generation);
    catalogs.push({
      key: m.key, game: m.game, lang: m.lang, model: m.model, dim: m.dim,
      generation: m.generation, rows: m.rows, segments: m.segments.length,
      bytes: m.segments.reduce((n, s) => n + s.bytes, 0), updatedAt: m.updatedAt,
    });
  }
  catalogs.sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(path.join(out, 'catalogs.json'),
    `${JSON.stringify({ format: 1, updatedAt: new Date().toISOString(), catalogs }, null, 1)}\n`);
  // Only segments of a generation OLDER than the one their catalog's manifest is
  // on: those are unreachable by construction. Anything else stays, however odd —
  // a wrong delete breaks every install, a missed one costs some storage.
  const stale = names.filter((name) => {
    const m = /^(.+)\.g(\d+)\.\d+\.seg$/.exec(name);
    return m && current.has(m[1]) && Number(m[2]) < current.get(m[1]);
  });
  fs.writeFileSync(path.join(out, 'delete.txt'), stale.map(s => `${s}\n`).join(''));
  summary([
    `### Scan catalogs`,
    '',
    '| catalog | rows | generation | segments | size | updated |',
    '|---|---:|---:|---:|---:|---|',
    ...catalogs.map(c => `| ${c.key} | ${c.rows} | ${c.generation} | ${c.segments} | ${mb(c.bytes)} | ${c.updatedAt} |`),
    '',
    stale.length ? `Old segments to delete: ${stale.join(', ')}` : 'No old segments to delete.',
  ]);
}

// --- build ---------------------------------------------------------------------

async function build(args) {
  const key = String(args.key || '');
  const km = KEY_RE.exec(key);
  if (!km) throw new Error(`--key must look like mtg-en or pokemon-ja, not "${key}"`);
  const [, game, code] = km;
  const out = path.resolve(args.out || '.');
  fs.mkdirSync(out, { recursive: true });
  if (!process.env.CV_MODEL_DIR || !fs.existsSync(path.join(process.env.CV_MODEL_DIR, 'milo.onnx'))) {
    throw new Error('CV_MODEL_DIR must point at a folder holding milo.onnx (backend/scripts/fetch-models.mjs)');
  }

  // A throwaway database, set before anything opens one.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-catalog-${key}-`));
  process.env.DB_PATH = path.join(work, 'build.db');
  process.env.CATALOG_AUTO_UPDATE = '0';

  const db = backend('./src/db');
  const catalog = backend('./src/catalog');
  const games = backend('./src/utils/games');
  const languages = backend('./src/utils/languages');
  const segments = backend('./src/utils/catalogSegments');
  const releaseAssets = backend('./src/utils/releaseAssets');
  const { MODEL_ID } = backend('./src/utils/miloInput');
  await db.initDb();

  if (!catalog.GAMES.includes(game)) throw new Error(`${game} has no scanner`);
  if (languages.toCode(code) !== code) throw new Error(`unknown language ${code}`);
  const lang = languages.toName(code);
  const sets = args.sets ? String(args.sets).split(',').map(s => s.trim()).filter(Boolean) : [];
  const t0 = Date.now();

  // 1. Last week's catalog, as installs see it. --fresh still reads it, for the
  // generation number, but embeds every card again and publishes a new base.
  const prev = await restore(key, { releaseAssets, segments });
  const reuse = !!prev && !args.fresh && prev.manifest.model === MODEL_ID;
  if (prev) {
    console.log(`${key}: published generation ${prev.manifest.generation}, ${prev.ids.length} rows in ${prev.manifest.segments.length} segment(s)${reuse ? '' : ' — not reused'}`);
  } else {
    console.log(`${key}: nothing published yet; building from scratch`);
  }
  // The resume input for catalog.js: its own local-catalog files.
  if (reuse) {
    const bin = Buffer.from(prev.cat.buffer, prev.cat.byteOffset, prev.cat.byteLength);
    fs.writeFileSync(catalog.binPath(game, lang), bin);
    fs.writeFileSync(catalog.metaPath(game, lang), JSON.stringify({
      dim: prev.dim, ids: prev.ids, srcs: prev.srcs, game, lang, model: MODEL_ID, builtAt: prev.manifest.updatedAt,
    }));
  } else {
    fs.rmSync(catalog.binPath(game, lang), { force: true });
    fs.rmSync(catalog.metaPath(game, lang), { force: true });
  }

  // 2. Every card, then the embeddings.
  const run = async (opts) => {
    catalog.start(game, lang, { ...opts, sets });
    const ticker = setInterval(() => {
      const s = catalog.state();
      if (s) console.log(`  ${s.phase} ${s.done}/${s.total} ${s.message || ''}`);
    }, 60000);
    try {
      await catalog.whenIdle();
    } finally {
      clearInterval(ticker);
    }
    const r = catalog.lastResult();
    if (!r || r.phase !== 'done') throw new Error(`${key}: build ${r ? r.phase : 'did not run'}: ${r ? r.message : ''}`);
    console.log(`  ${r.message}`);
    return r;
  };

  let coverage = null;
  let skipped = [];
  const tcgplayer = game === 'pokemon' ? backend('./src/pokemonTcgplayer') : null;
  if (tcgplayer && tcgplayer.LANGS[lang] && !sets.length) {
    // Pokémon: TCGdex first, then the TCGplayer groups it lacks, then embed both.
    skipped = (await run({ cacheOnly: true })).skipped || [];
    const tcgcsv = backend('./src/tcgcsvApi');
    const synced = await tcgcsv.syncIfUpdated({ explicit: true });
    if (synced && synced.disabled) throw new Error('TCGCSV sync is disabled (BINDARR_DISABLE_TCGCSV_SYNC=1)');
    coverage = await tcgplayer.computeCoverage(lang);
    const wrote = await tcgplayer.materialize(lang, coverage, { force: true });
    console.log(`${key}: ${coverage.fallbackGroups.length} TCGplayer group(s) TCGdex lacks (${wrote.cards || 0} cards), art borrowed for ${Object.keys(coverage.artFill).length} TCGdex card(s)`);
    await run({ skipCache: true });
  } else {
    skipped = (await run({})).skipped || [];
  }

  // 3. What changed against what is published.
  if (!fs.existsSync(catalog.metaPath(game, lang))) throw new Error(`${key}: the build produced no rows`);
  const meta = JSON.parse(fs.readFileSync(catalog.metaPath(game, lang), 'utf8'));
  const buf = fs.readFileSync(catalog.binPath(game, lang));
  const dim = meta.dim;
  const ids = meta.ids;
  const n = ids.length;
  if (!n) throw new Error(`${key}: the build produced no rows`);
  const cat = new Float32Array(buf.buffer, buf.byteOffset, n * dim);
  const halves = new Uint16Array(n * dim);
  for (let i = 0; i < halves.length; i++) halves[i] = segments.toHalf(cat[i]);

  const diffable = reuse && prev.dim === dim;
  const changed = [];
  let removes = [];
  if (diffable) {
    const where = new Map(prev.ids.map((id, i) => [id, i]));
    for (let i = 0; i < n; i++) {
      const j = where.get(ids[i]);
      if (j === undefined) { changed.push(i); continue; }
      for (let d = 0; d < dim; d++) {
        if (halves[i * dim + d] !== segments.toHalf(prev.cat[j * dim + d])) { changed.push(i); break; }
      }
    }
    const now = new Set(ids);
    removes = prev.ids.filter(id => !now.has(id));
    const limit = Math.max(50, Math.ceil(prev.ids.length * MAX_REMOVED_SHARE));
    if (removes.length > limit && !args['allow-removals']) {
      throw new Error(`${key}: ${removes.length} of ${prev.ids.length} published cards are gone (limit ${limit}) — `
        + 'a provider failing, most likely. Nothing published; rerun with --allow-removals if it is real.');
    }
  }

  const published = prev ? prev.manifest.segments : [];
  const deltas = published.filter(s => !s.base);
  const pending = deltas.reduce((t, s) => t + s.rows + (s.removes || 0), 0) + changed.length + removes.length;
  const rebase = !diffable || !!args.rebase || deltas.length + 1 > MAX_DELTAS || pending > REBASE_SHARE * n;
  const files = [];
  let manifest = null;
  let segment = null;

  if (sets.length) {
    console.log(`${key}: built from ${sets.length} set(s) only (--sets) — writing the files, but this is not a catalog to publish`);
  }
  if (rebase || changed.length || removes.length) {
    const generation = rebase ? (prev ? prev.manifest.generation + 1 : 1) : prev.manifest.generation;
    const seq = rebase ? 0 : Math.max(...published.map(s => s.seq)) + 1;
    const rowsOut = rebase ? [...ids.keys()] : changed;
    const vectors = new Float32Array(rowsOut.length * dim);
    rowsOut.forEach((i, r) => vectors.set(cat.subarray(i * dim, (i + 1) * dim), r * dim));
    const bytes = segments.encodeSegment({
      key, game, lang, model: MODEL_ID, dim, generation, seq, base: rebase,
      ids: rowsOut.map(i => ids[i]), vectors, removes: rebase ? [] : removes,
    });
    segments.decodeSegment(bytes);   // what installs will do with it
    const name = `${key}.g${generation}.${seq}.seg`;
    fs.writeFileSync(path.join(out, name), bytes);
    segment = { name, seq, base: rebase, rows: rowsOut.length, removes: rebase ? 0 : removes.length, bytes: bytes.length, sha256: sha256(bytes) };
    manifest = {
      format: 1, key, game, lang, model: MODEL_ID, dim, generation, rows: n,
      updatedAt: new Date().toISOString(),
      segments: [...(rebase ? [] : published), segment],
    };
    fs.writeFileSync(path.join(out, `${key}.json`), `${JSON.stringify(manifest, null, 1)}\n`);
    // The image each row came from: next week's resume key. Only the build reads it.
    const state = zlib.gzipSync(JSON.stringify({ key, generation, srcs: meta.srcs || {} }), { level: 9 });
    fs.writeFileSync(path.join(out, `${key}.state.json.gz`), state);
    files.push(name, `${key}.state.json.gz`);
  }

  if (coverage) {
    // Installs re-read this daily; only a change in WHAT it says is worth an upload.
    const asset = tcgplayer.coverageAsset(code);
    const before = await releaseAssets.fetchJson(asset).catch(() => null);
    const same = before && JSON.stringify([before.fallbackGroups, before.artFill]) === JSON.stringify([coverage.fallbackGroups, coverage.artFill]);
    if (!same) {
      fs.writeFileSync(path.join(out, asset), `${JSON.stringify(coverage)}\n`);
      files.push(asset);
    }
  }

  const publishable = !sets.length;
  fs.writeFileSync(path.join(out, 'publish.json'), `${JSON.stringify({
    key, upload: publishable ? files : [], manifest: publishable && manifest ? `${key}.json` : null,
  }, null, 1)}\n`);

  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  summary([
    `### ${key}`,
    '',
    `${n} cards, ${dim}d, built in ${minutes} min.`,
    segment
      ? `${publishable ? 'Publishing' : 'Wrote, not for publishing:'} ${segment.base ? `a new base (generation ${manifest.generation})` : `delta ${segment.seq} of generation ${manifest.generation}`}: `
        + `${segment.rows} row(s)${segment.removes ? `, ${segment.removes} removed` : ''}, ${mb(segment.bytes)}.`
        + ` A current install downloads ${mb(segment.bytes)}; a new one ${mb(manifest.segments.reduce((t, s) => t + s.bytes, 0))}.`
      : 'No change since the published catalog: nothing to upload.',
    // Normal for some catalogues (TCGdex lists Japanese sets it has no cards for);
    // a jump here between weeks is a provider failing, and worth a look.
    skipped.length ? `Sets skipped, no card data upstream (${skipped.length}): ${skipped.slice(0, 30).join(', ')}${skipped.length > 30 ? ', …' : ''}.` : '',
    coverage ? `TCGplayer fallback: ${coverage.fallbackGroups.length} group(s)${files.includes(tcgplayer.coverageAsset(code)) ? ' (updated)' : ' (unchanged)'}.` : '',
  ].filter(s => s !== undefined));

  // Best effort: on Windows the open database keeps the folder until exit.
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the OS cleans its temp folder */ }
}

// The published catalog for `key`, or null when there is none yet.
async function restore(key, { releaseAssets, segments }) {
  const manifest = await releaseAssets.fetchJson(`${key}.json`);
  if (!manifest) return null;
  const decoded = [];
  for (const s of manifest.segments) {
    const bytes = await releaseAssets.fetchAsset(s.name, { timeoutMs: 600000 });
    if (bytes.length !== s.bytes || sha256(bytes) !== s.sha256) {
      throw new Error(`${s.name} does not match the published manifest; refusing to build on it`);
    }
    decoded.push(segments.decodeSegment(bytes));
  }
  const { ids, cat, dim } = segments.applySegments(decoded);
  let srcs = {};
  try {
    const gz = await releaseAssets.fetchAsset(`${key}.state.json.gz`, { timeoutMs: 600000 });
    srcs = JSON.parse(zlib.gunzipSync(gz).toString('utf8')).srcs || {};
  } catch (e) {
    if (e.code !== 'ASSET_MISSING') throw e;
    // Without it every card re-embeds once: slow, not wrong.
    console.warn(`${key}: no ${key}.state.json.gz; every card will be embedded again`);
  }
  return { manifest, ids, cat, dim, srcs };
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.index) index(args);
  else await build(args);
  // Provider clients keep sockets and timers alive; the work is done.
  process.exit(0);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
