// Persistent worker-thread pool for set-scoped ORB verification. The ~300 per-set
// card verifies are independent and CPU-bound in single-threaded opencv-wasm, so
// we shard them across N workers. Lossless: identical computation, just parallel.
//
// Size via SCAN_WORKERS env (0 disables → caller runs inline). Default: a safe
// fraction of cores, capped, since each worker holds its own ~128MB cv heap.
const path = require('path');
const os = require('os');

let pool = null; // null = not built; [] = disabled/no workers

function size() {
  const env = parseInt(process.env.SCAN_WORKERS, 10);
  if (Number.isFinite(env)) return Math.max(0, env);
  return Math.min(4, Math.max(1, (os.cpus().length || 2) - 1));
}

function getPool() {
  if (pool !== null) return pool;
  const n = size();
  if (n === 0) { pool = []; return pool; }
  const { Worker } = require('worker_threads');
  pool = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(path.join(__dirname, 'scanWorker.js'));
    w._pending = new Map();
    w._seq = 0;
    w.on('message', (m) => {
      const p = w._pending.get(m.id);
      if (!p) return;
      w._pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.out !== undefined ? m.out : m.scored);
    });
    w.on('error', (e) => { for (const p of w._pending.values()) p.reject(e); w._pending.clear(); });
    pool.push(w);
  }
  console.log(`scanPool: ${n} worker(s) ready`);
  return pool;
}

function job(w, payload) {
  return new Promise((resolve, reject) => {
    const id = ++w._seq;
    w._pending.set(id, { resolve, reject });
    w.postMessage({ id, ...payload });
  });
}

let extractRr = 0;

// Dispatch single-card ORB extraction to a worker thread. Returns extracted
// features object { desc, kp, count }, or null if pool is disabled.
async function extract(rgba, width, height) {
  const workers = getPool();
  if (workers.length === 0) return null;
  const w = workers[extractRr % workers.length];
  extractRr = (extractRr + 1) % workers.length;
  return job(w, { type: 'extract', rgba, width, height });
}

// Verify all `total` cards of a set across the pool. qDesc/qKp are plain typed
// arrays (structured-cloned to each worker). Returns merged scored[] (unsorted),
// or null if the pool is disabled so the caller can run inline.
async function verify(game, set, qDesc, qRows, qKp, total) {
  const workers = getPool();
  if (workers.length === 0) return null;
  const n = workers.length;
  const per = Math.ceil(total / n);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const start = i * per, end = Math.min(total, start + per);
    if (start >= end) break;
    jobs.push(job(workers[i], { game, set, qDesc, qRows, qKp, start, end }));
  }
  const results = await Promise.all(jobs);
  return results.flat();
}

module.exports = { verify, extract, getPool };
