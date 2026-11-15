// Riftbound card ids must not need Node's Buffer (MOB-16).
//
// The phone app runs riftcodexApi in device mode, where there is no Buffer, and
// encodeCode/decodeCode wrote and read the '.2a' escapes of a code like
// 'unl-229*-219' with Buffer — so every Riftbound id with a '*' in it threw there.
// This hides Buffer while the id round-trips, as the phone's WebView would.
// Run: `node test/riftboundnobuffer.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-riftboundnobuffer-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../src/db');
const rc = require('../src/riftcodexApi');
process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
});

const saved = global.Buffer;
let ids;
try {
  global.Buffer = undefined;
  ids = {
    signature: rc.cardIdFor('UNL-229*-219'),
    accented: rc.cardIdFor('ogn-é1-298'),
    parsed: rc.parseCardId('riftbound-unl-229.2a-219'),
    variant: rc.parseCardId(rc.cardIdFor('opp-259-298', '69BC5BF1d308c64675ca89f7')),
    badEscape: rc.decodeCode('a.zz'),
  };
} finally {
  global.Buffer = saved;
}

assert.strictEqual(ids.signature, 'riftbound-unl-229.2a-219', "'*' is written as its UTF-8 byte");
assert.strictEqual(ids.accented, 'riftbound-ogn-.c3.a91-298', 'a two-byte character is two escapes');
assert.deepStrictEqual(ids.parsed, { riftboundId: 'unl-229*-219', variant: null });
assert.deepStrictEqual(ids.variant, { riftboundId: 'opp-259-298', variant: '69bc5bf1d308c64675ca89f7' });
assert.strictEqual(ids.badEscape, null, 'a malformed escape is still refused');
assert.strictEqual(rc.decodeCode(rc.encodeCode('ogn-é1-298')), 'ogn-é1-298', 'and it round-trips with Buffer back');

console.log('riftboundnobuffer.test.js: all assertions passed');
db.dbConnection.close(() => {});
