import test from 'node:test';
import assert from 'node:assert';
import { readCappedJson, TooLargeError } from './cappedJson.js';

const json = (value) => JSON.stringify(value);

// A streamed body in chunks, counting how many were pulled.
function streamed(text, { chunk = 64, headers = {} } = {}) {
  const bytes = new TextEncoder().encode(text);
  const counter = { pulled: 0, cancelled: false };
  let at = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      counter.pulled++;
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
    cancel() { counter.cancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { headers }), counter };
}

test('a body within the cap is parsed', async () => {
  const manifest = { format: 1, segments: [{ name: 'x.seg', bytes: 10 }] };
  assert.deepStrictEqual(await readCappedJson(new Response(json(manifest)), 1024), manifest);
  const { res } = streamed(json(manifest), { chunk: 7 });
  assert.deepStrictEqual(await readCappedJson(res, 1024), manifest, 'in chunks too');
  assert.deepStrictEqual(await readCappedJson(new Response(json(manifest)), json(manifest).length), manifest, 'exactly at the cap');
});

test('a declared length over the cap is refused before the body is read', async () => {
  const { res, counter } = streamed(json({ big: 'x'.repeat(5000) }), { headers: { 'content-length': '5012' } });
  await assert.rejects(readCappedJson(res, 1024, 'catalogs.json'), (err) => {
    assert.ok(err instanceof TooLargeError);
    assert.match(err.message, /catalogs\.json is larger than the 1024 bytes/);
    return true;
  });
  assert.strictEqual(counter.pulled, 0, 'nothing was read');
});

test('a body that runs past the cap with no length given stops as it streams', async () => {
  const { res, counter } = streamed('[' + '1,'.repeat(100000) + '1]', { chunk: 256 });
  await assert.rejects(readCappedJson(res, 4096), TooLargeError);
  assert.ok(counter.pulled <= 4096 / 256 + 1, `stopped after ${counter.pulled} chunks`);
  assert.strictEqual(counter.cancelled, true, 'the rest is cancelled');
});

test('a body without a stream is checked once read', async () => {
  const res = { headers: new Headers(), body: null, arrayBuffer: async () => new TextEncoder().encode(json({ a: 'x'.repeat(100) })).buffer };
  await assert.rejects(readCappedJson(res, 50), TooLargeError);
  const small = { headers: new Headers(), body: null, arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer };
  assert.deepStrictEqual(await readCappedJson(small, 50), { a: 1 });
});

test('what is not JSON still fails as a parse error', async () => {
  await assert.rejects(readCappedJson(new Response('<html>'), 1024), SyntaxError);
});
