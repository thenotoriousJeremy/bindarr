// A TCP port nothing is listening on, for a test server to bind.
//
// The e2e suites used to hard-code theirs (3009, 3011, 3012, 3013, 3019, 3020,
// 3030 and up), so two runs at once — a second checkout, a CI job on the same
// box, or just a dev server that happened to sit on one of them — fought over
// the same numbers and failed with nothing pointing at why. Asking the OS for
// port 0 gets a free one from its ephemeral range instead.
//
// The probe closes before the caller's server binds, so in principle another
// process could take the port in between. That window is a few milliseconds and
// a collision fails loudly at startup, which is accepted rather than engineered
// away: holding the socket open and handing it to a child process is not
// something a spawned `node src/server.js` can take.
//
//   const { freePort } = require('../freePort');   // from test/e2e
//   const port = await freePort();                  // a number
const net = require('net');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    // No host: the unspecified address (dual-stack where IPv6 is available),
    // which covers the 0.0.0.0 that server.js binds.
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
