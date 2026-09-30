// Two rows naming one printing (a foil and a non-foil copy of the same set and
// collector number) must both pair with the card Scryfall returns. Keyed by
// printing alone, the second row overwrote the first and a ManaBox import lost
// every non-foil copy of a card it also listed as foil.
// Run: `node test/scryfallbulkpairs.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-bulkpairs-${process.pid}.db`);
const scryfallApi = require('../src/scryfallApi');

let sent;
scryfallApi.client.defaults.adapter = async (config) => {
  sent = JSON.parse(config.data).identifiers;
  const data = sent.map(({ set, collector_number }) => ({
    id: '00000000-0000-0000-0000-000000000339', name: 'Mountain', set, collector_number,
    set_name: 'Seventh Edition', prices: {}, image_uris: {}
  }));
  return { status: 200, statusText: 'OK', headers: {}, config, data: { object: 'list', data, not_found: [] } };
};

(async () => {
  const { pairs } = await scryfallApi.bulkFetchByIdentifier([
    { set_id: '7ED', number: '339', printing: 'Normal', quantity: 6 },
    { set_id: '7ED', number: '339', printing: 'Holofoil', quantity: 1 }
  ]);
  assert.strictEqual(sent.length, 1, 'one printing is asked for once');
  assert.deepStrictEqual(pairs.map(p => p.row.printing).sort(), ['Holofoil', 'Normal']);
  console.log('scryfallbulkpairs.test.js OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
