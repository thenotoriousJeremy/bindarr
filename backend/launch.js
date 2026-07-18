// SEA entry for the packaged Windows server (.exe).
//
// The exe is a Node Single Executable Application whose bundled blob is ONLY
// this launcher (pure JS, node: builtins). It boots the REAL server from the
// `app/backend` folder shipped beside the exe, so native modules (sqlite3,
// sharp, onnxruntime-node) and the ESM @huggingface/transformers load from a
// real on-disk node_modules exactly as under plain `node` — SEA's no-native-
// addon limit never bites, because none of them are in the blob. server.js is
// unmodified: __dirname resolves to the real app/backend/src, so
// ../../frontend/dist and ./data resolve too.
const { createRequire } = require('node:module');
const path = require('node:path');

const appBackend = path.join(path.dirname(process.execPath), 'app', 'backend');
process.chdir(appBackend); // dotenv reads ./.env, sqlite writes are cwd-relative
const req = createRequire(path.join(appBackend, 'launch-anchor.js'));
req(path.join(appBackend, 'src', 'server.js'));
