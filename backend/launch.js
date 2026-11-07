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

// Double-clicked from Explorer, the console window dies with the process — so a
// startup crash showed as a window that "opens and closes really quick" with no
// clue what went wrong. Print the error and wait for a keypress instead.
function fatal(err) {
  console.error('\nBindarr could not start.\n');
  console.error(err && err.stack ? err.stack : String(err));
  if (err && err.code === 'MODULE_NOT_FOUND') {
    console.error(
      '\nA file the server needs is missing from this download. Please report this at\n' +
      'https://github.com/thenotoriousJeremy/bindarr/issues with the text above.'
    );
  }
  console.error('\nPress any key to close...');
  try {
    // Raw mode gives us a single keypress; falls through if stdin is not a TTY
    // (piped/service), where exiting immediately is the right behaviour.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
      return;
    }
  } catch { /* not interactive — fall through */ }
  process.exit(1);
}

process.on('uncaughtException', fatal);
// No unhandledRejection here: server.js logs those and keeps serving, and a
// second listener that exits would undo that. Startup failures are caught in
// server.js itself, or are thrown synchronously and land in the catch below.

try {
  const appBackend = path.join(path.dirname(process.execPath), 'app', 'backend');
  process.chdir(appBackend); // dotenv reads ./.env, sqlite writes are cwd-relative
  const req = createRequire(path.join(appBackend, 'launch-anchor.js'));
  req(path.join(appBackend, 'src', 'server.js'));
} catch (err) {
  fatal(err);
}
