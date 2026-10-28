const assert = require('assert');
const { EventEmitter } = require('events');
const metricsModule = require('../src/utils/metrics');
const getCollectionMetrics = require('../src/utils/collectionMetrics');
const metrics = metricsModule.createMetrics();

async function main() {
  const request = (method, path, status, route) => {
    const req = { method, path, route: route ? { path: route } : undefined, baseUrl: '/api' };
    const res = new EventEmitter();
    res.statusCode = status;
    metrics.middleware(req, res, () => {});
    res.emit('finish');
  };

  request('GET', '/api/cards', 200, '/cards');
  request('POST', '/api/cards', 422, '/cards');
  request('GET', '/api/missing', 404);
  request('DELETE', '/api/failure', 500, '/failure');
  request('GET', '/static/app.js', 200, '/static/app.js');

  const requestMetrics = metrics.snapshot().requests;
  assert.strictEqual(requestMetrics.calls, 4);
  assert.strictEqual(requestMetrics.errors, 3);
  assert.strictEqual(requestMetrics.clientErrors, 2);
  assert.strictEqual(requestMetrics.serverErrors, 1);
  assert.deepStrictEqual(requestMetrics.routes.map(row => row.route), [
    'GET /api/cards',
    'POST /api/cards',
    'GET unmatched',
    'DELETE /api/failure',
  ]);

  const handlers = { request: [], response: [] };
  const client = {
    interceptors: {
      request: { use: handler => handlers.request.push(handler) },
      response: { use: (onSuccess, onError) => handlers.response.push({ onSuccess, onError }) },
    },
  };

  metrics.instrumentAxiosClient(client, 'tcgdex');
  metrics.instrumentAxiosClient(client, 'tcgdex');
  assert.strictEqual(handlers.request.length, 1);
  assert.strictEqual(handlers.response.length, 1);

  let config = handlers.request[0]({ method: 'get' });
  handlers.response[0].onSuccess({ config, status: 200 });
  config = handlers.request[0]({ method: 'get' });
  await assert.rejects(handlers.response[0].onError({
    config,
    response: { status: 503 },
  }));

  const secondHandlers = { request: [], response: [] };
  const secondClient = {
    interceptors: {
      request: { use: handler => secondHandlers.request.push(handler) },
      response: { use: (onSuccess, onError) => secondHandlers.response.push({ onSuccess, onError }) },
    },
  };
  metrics.instrumentAxiosClient(secondClient, 'tcgdex');
  config = secondHandlers.request[0]({ method: 'get' });
  secondHandlers.response[0].onSuccess({ config, status: 200 });
  metrics.recordProviderCall('tcgdex', undefined, 200, 'card_image');

  const providerMetrics = metrics.snapshot().providers;
  assert.strictEqual(providerMetrics.length, 1);
  assert.strictEqual(providerMetrics[0].provider, 'tcgdex');
  assert.strictEqual(providerMetrics[0].calls, 4);
  assert.strictEqual(providerMetrics[0].errors, 1);
  assert.strictEqual(providerMetrics[0].serverErrors, 1);
  assert.deepStrictEqual(providerMetrics[0].operations.map(item => [item.operation, item.calls]), [
    ['api', 3],
    ['card_image', 1],
  ]);

  let collectionQuery = 0;
  const collection = await getCollectionMetrics({
    all: async () => {
      collectionQuery++;
      if (collectionQuery === 1) {
        return [
          { id: 1, username: 'alice', unique_cards: 2, total_cards: 3, total_value: 12.34, cards_added_30d: 1 },
          { id: 2, username: 'bob "B"', unique_cards: 0, total_cards: 0, total_value: 0, cards_added_30d: 0 },
        ];
      }
      return [
        { user_id: 1, username: 'alice', game: 'pokemon', types: '["Fire"]', subtypes: '[]', supertype: 'Pokémon', cards: 3 },
        { user_id: 2, username: 'bob "B"', game: 'mtg', types: '[]', subtypes: '["Land"]', supertype: 'MTG', cards: 2 },
      ];
    },
  });
  assert.strictEqual(collection.userCount, 2);
  assert.strictEqual(collection.totalCards, 3);
  assert.strictEqual(collection.uniqueCards, 2);
  assert.strictEqual(collection.totalValue, 12.34);
  assert.strictEqual(collection.cardsAdded30d, 1);
  assert.deepStrictEqual(collection.types.map(item => item.name), ['Fire', 'Land']);

  const exposition = metrics.toPrometheus(collection);
  assert.match(exposition, /bindarr_process_memory_bytes\{type="rss"\}/);
  assert.match(exposition, /bindarr_collection_users 2/);
  assert.match(exposition, /bindarr_collection_cards\{kind="owned"\} 3/);
  assert.match(exposition, /bindarr_collection_estimated_value 12\.34/);
  assert.match(exposition, /bindarr_collection_user_cards\{user_id="1",username="alice",kind="owned"\} 3/);
  assert.match(exposition, /username="bob \\"B\\"",game="mtg",type="Land"/);
  assert.match(exposition, /bindarr_http_request_average_duration_seconds/);
  assert.match(exposition, /bindarr_http_requests_total\{method="GET",route="\/api\/cards"\} 1/);
  assert.match(exposition, /bindarr_http_request_max_duration_seconds\{method="GET",route="\/api\/cards"\}/);
  assert.match(exposition, /bindarr_upstream_requests_total\{provider="tcgdex"\} 4/);
  assert.match(exposition, /bindarr_upstream_requests_by_operation_total\{provider="tcgdex",operation="api"\} 3/);
  assert.match(exposition, /bindarr_upstream_requests_by_operation_total\{provider="tcgdex",operation="card_image"\} 1/);
  assert.match(exposition, /bindarr_upstream_request_errors_total\{provider="tcgdex"\} 1/);
  assert.match(exposition, /bindarr_upstream_request_max_duration_seconds\{provider="tcgdex"\}/);

  const disabled = metricsModule.createMetrics({ enabled: false });
  let nextCalls = 0;
  disabled.middleware(
    { path: '/api/cards', method: 'GET' },
    new EventEmitter(),
    () => { nextCalls++; }
  );
  assert.strictEqual(nextCalls, 1);
  assert.strictEqual(disabled.snapshot().requests.calls, 0);

  console.log('metrics.test.js passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
