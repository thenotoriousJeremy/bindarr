// A small pool of embed workers for catalog builds (see embedWorker.js for why
// embedding cannot share the server's thread).
//
//   const pool = await createEmbedder(modelPath);
//   const vec = await pool.embed(imageBytes);   // Float32Array, 128-d
//   await pool.close();
//
// Size: CATALOG_EMBED_WORKERS, else one fewer than the cores up to four. Four
// workers measured ~4x one on a 32-core desktop; past that the image downloads
// are the limit, and a Raspberry Pi keeps a core for the server itself.
//
// If no worker can start (a platform where onnxruntime-node will not load in a
// worker thread, say), embedding falls back to the server thread exactly as it
// ran before the pool existed: slower and blocking, but a build still finishes.
'use strict';

const path = require('path');

function defaultSize() {
  const fromEnv = Number(process.env.CATALOG_EMBED_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return Math.min(fromEnv, 16);
  let cores = 2;
  try { cores = require('os').availableParallelism?.() || require('os').cpus().length || 2; } catch { /* keep 2 */ }
  return Math.max(1, Math.min(4, cores - 1));
}

// The pre-pool path, kept as the fallback: same preprocessing, on this thread.
async function inProcessEmbedder(model) {
  const sharp = require('sharp');
  const ort = require('onnxruntime-node');
  const { SIZE, toTensorData } = require('./utils/miloInput');
  const session = await ort.InferenceSession.create(model, {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });
  return {
    size: 1,
    workers: 0,
    async embed(buf) {
      const { data } = await sharp(buf).resize(SIZE, SIZE, { fit: 'fill' })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = await session.run({ image: new ort.Tensor('float32', toTensorData(data), [1, 3, SIZE, SIZE]) });
      return Float32Array.from(out.embedding.data);
    },
    async close() { try { await session.release?.(); } catch { /* best effort */ } },
  };
}

function startWorker(model) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'embedWorker.js'), { workerData: { model } });
    const fail = (err) => { w.terminate().catch(() => {}); reject(err); };
    w.once('error', fail);
    w.once('exit', (code) => fail(new Error(`embed worker exited (${code}) before it was ready`)));
    w.once('message', (m) => {
      w.removeAllListeners('error');
      w.removeAllListeners('exit');
      if (m && m.ready) resolve(w);
      else fail(new Error(m && m.fatal ? m.fatal : 'embed worker failed to start'));
    });
  });
}

async function createEmbedder(model, { size = defaultSize() } = {}) {
  const started = await Promise.allSettled(Array.from({ length: size }, () => startWorker(model)));
  const workers = started.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!workers.length) {
    const why = started.find(r => r.status === 'rejected')?.reason?.message || 'unknown';
    console.warn(`catalog: embed workers unavailable (${why}); embedding on the server thread`);
    return inProcessEmbedder(model);
  }

  const idle = [...workers];
  const queue = [];               // { id, buf, resolve, reject }
  const jobs = new Map();         // id -> job, while a worker has it
  const owner = new Map();        // worker -> job id
  let nextId = 1;
  let closed = false;

  const dispatch = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const job = queue.shift();
      jobs.set(job.id, job);
      owner.set(w, job.id);
      // Transfer, not copy: these are 100-300 KB images, tens of thousands of them.
      const ab = job.buf.buffer.slice(job.buf.byteOffset, job.buf.byteOffset + job.buf.byteLength);
      w.postMessage({ id: job.id, buf: ab }, [ab]);
    }
  };

  const retire = (w, err) => {
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
    const k = idle.indexOf(w);
    if (k >= 0) idle.splice(k, 1);
    const id = owner.get(w);
    owner.delete(w);
    if (id != null && jobs.has(id)) { jobs.get(id).reject(err); jobs.delete(id); }
    // The last worker gone: nothing will ever take the queued jobs.
    if (!workers.length) for (const job of queue.splice(0)) job.reject(err);
  };

  for (const w of workers) {
    w.on('message', (m) => {
      const job = jobs.get(m.id);
      if (!job) return;
      jobs.delete(m.id);
      owner.delete(w);
      if (m.error) job.reject(new Error(m.error)); else job.resolve(m.vec);
      if (!closed) { idle.push(w); dispatch(); }
    });
    // A crashed worker fails only the card it held; the others carry the build.
    w.on('error', (err) => retire(w, err));
    w.on('exit', (code) => { if (!closed) retire(w, new Error(`embed worker exited (${code})`)); });
  }

  return {
    size: workers.length,
    workers: workers.length,
    embed(buf) {
      if (closed) return Promise.reject(new Error('embed pool is closed'));
      if (!workers.length) return Promise.reject(new Error('no embed workers left'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, buf, resolve, reject });
        dispatch();
      });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('embed pool closed'));
      await Promise.all(workers.map(w => w.terminate().catch(() => {})));
    },
  };
}

module.exports = { createEmbedder, defaultSize };
