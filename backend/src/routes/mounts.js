// Every /api route, once, for both places that serve them: server.js on a server,
// and embedded/index.js inside the phone app (device mode, MOBILE.md).
//
// The two used to keep their own lists by hand, and the lists drifted: the trash
// routes never reached the phone, so Undo and the Trash dialog answered 404 there,
// and notifications and binder art 404'd instead of saying they need a server.
// Now an entry says where a router mounts and what a phone does with it:
//
//   device: 'mount'  the phone runs the same router. `router` is a function that
//                    requires it, so the app's bundle (frontend/scripts/
//                    build-device-backend.mjs) includes it.
//   device: 501      a server-only feature. `router` is the file's name, not a
//                    require, so the bundle never pulls it (or its native
//                    dependencies) in; server.js requires it by that name. The
//                    phone answers 501 "needs a server" at `path`, or at each of
//                    `devicePaths` for a router mounted on bare /api that names
//                    full paths inside.
//
// `public` routes mount ahead of the authentication gate, the rest after it, in
// this order: order is behaviour (the trash router has to come before the
// collection router, whose DELETE /collection/:id would take "trash" as an id).
// test/apimounts.test.js holds server.js, this table and the phone to each other.
'use strict';

const API_MOUNTS = [
  { path: '/api/auth', router: () => require('./auth'), public: true, device: 'mount' },
  // Public share links: nothing on the internet can reach a phone to follow one.
  { path: '/api/shared', router: 'shared', public: true, device: 501 },
  // Accounts, server backups and scan catalogs. Admin carries its own
  // authenticateToken + requireAdmin, so it sits above the gate on a server.
  { path: '/api/admin', router: 'admin', public: true, device: 501 },
  // Contributed card art is decoded with sharp, which has no phone build. Reads
  // are public on a server because a shared collection renders the art too.
  { path: '/api/card-art', router: 'cardArt', public: true, device: 501 },
  // ECB reference rates: public data, and a shared collection converts with them.
  { path: '/api/fx', router: () => require('./fx'), public: true, device: 'mount' },

  // --- behind the authentication gate ---
  // Ahead of the collection router (see the top of this file).
  { path: '/api/collection/trash', router: () => require('./trash'), device: 'mount' },
  { path: '/api', router: () => require('./collection'), device: 'mount' },
  { path: '/api', router: () => require('./storage'), device: 'mount' },
  { path: '/api', router: () => require('./stats'), device: 'mount' },
  { path: '/api', router: () => require('./importExport'), device: 'mount' },
  { path: '/api', router: () => require('./notes'), device: 'mount' },
  { path: '/api', router: () => require('./sealed'), device: 'mount' },
  // Deals with people outside Bindarr: one account's own record, so the phone runs
  // it too. Full paths inside (/transfers/external...), ahead of the transfers
  // entry, whose 501 on the phone covers every other /api/transfers path.
  { path: '/api', router: () => require('./externalTransfers'), device: 'mount' },
  // Trades and gifts between accounts, which need the other account's server.
  { path: '/api', router: 'transfers', device: 501, devicePaths: ['/api/transfers'] },
  { path: '/api', router: () => require('./backup'), device: 'mount' },
  // Uploaded binder artwork is decoded with sharp too.
  {
    path: '/api',
    router: 'binderArt',
    device: 501,
    devicePaths: ['/api/binder-art', '/api/locations/:id/binder-art', '/api/compartments/:id/binder-art'],
  },
  { path: '/api/sets', router: () => require('./sets'), device: 'mount' },
  { path: '/api/decks', router: () => require('./decks'), device: 'mount' },
  // Full paths inside (/lists, /decks/:id/missing-list, /cards/:id/decks).
  { path: '/api', router: () => require('./lists'), device: 'mount' },
  { path: '/api/settings', router: () => require('./settings'), device: 'mount' },
  { path: '/api/set-completion', router: () => require('./setCompletion'), device: 'mount' },
  { path: '/api/precons', router: () => require('./precons'), device: 'mount' },
  // Price alerts go out through webhooks and mail relays a server reaches.
  { path: '/api/notifications', router: 'notifications', device: 501 },
];

// Answered by server.js itself rather than by a router: the readiness probe, which
// has to work while the database is still starting (see whenReady below). An
// orchestrator probes a server; there is nothing to probe on a phone.
const SERVER_HANDLERS = [
  { path: '/api/health', device: 501 },
];

// The entries for one side of the authentication gate, in mount order.
const mountsFor = ({ public: publicRoutes }) => API_MOUNTS.filter(entry => !!entry.public === publicRoutes);

// What the phone answers for a feature that needs a server. A distinct status, so
// the app can tell "not on this device" from "broken" (or from a 404 typo).
function notOnDevice(req, res) {
  res.status(501).json({ error: 'Not available when Bindarr runs on this device.', deviceMode: true });
}

// The paths a server-only entry is answered at on the phone.
const devicePathsOf = (entry) => entry.devicePaths || [entry.path];

function mountOnDevice(app, { public: publicRoutes }) {
  for (const entry of mountsFor({ public: publicRoutes })) {
    if (entry.device === 'mount') app.use(entry.path, entry.router());
    else for (const p of devicePathsOf(entry)) app.use(p, notOnDevice);
  }
  if (publicRoutes) {
    for (const handler of SERVER_HANDLERS) app.use(handler.path, notOnDevice);
  }
}

// /api while the database is still starting (DATA-20). initDb runs the schema
// migrations while the server already listens, and a request that ran then could
// read a column that does not exist yet, or write while a migration has foreign
// keys switched off. So until it is done every /api request gets a 503 with
// Retry-After, the answer a client already knows how to wait out. Mounted after
// /api/health, which reports the same state to an orchestrator.
const RETRY_AFTER_SECONDS = 5;

function whenReady(isReady) {
  return (req, res, next) => {
    if (isReady()) return next();
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(503).json({ error: 'Bindarr is starting up. Try again in a few seconds.', starting: true });
  };
}

module.exports = {
  API_MOUNTS,
  SERVER_HANDLERS,
  RETRY_AFTER_SECONDS,
  mountsFor,
  mountOnDevice,
  devicePathsOf,
  notOnDevice,
  whenReady,
};
