// `fs` inside the phone app: a filesystem with nothing on it.
//
// Everything the server keeps outside SQLite is for something a phone does not
// do — scan models and catalogs, server-side backups, uploaded card art, TLS
// certificates. Reporting that none of them exist is what makes each of those
// features answer the way an install without them does (scanning: 503
// notBuilt) instead of crashing. Writes fail with EROFS; mkdir alone succeeds,
// because db.js creates its database directory at load and on a phone the
// SQLite plugin owns that directory.
'use strict';

function fsError(code, syscall, path) {
  const err = new Error(`${code}: ${code === 'ENOENT' ? 'no such file or directory' : 'read-only file system'}, ${syscall} '${path}'`);
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

const missing = (syscall) => (path) => { throw fsError('ENOENT', syscall, path); };
const readOnly = (syscall) => (path) => { throw fsError('EROFS', syscall, path); };

module.exports = {
  existsSync: () => false,
  mkdirSync: () => undefined,
  readdirSync: () => [],
  statSync: missing('stat'),
  lstatSync: missing('lstat'),
  readFileSync: missing('open'),
  createReadStream: missing('open'),
  writeFileSync: readOnly('open'),
  appendFileSync: readOnly('open'),
  createWriteStream: readOnly('open'),
  renameSync: readOnly('rename'),
  copyFileSync: readOnly('copyfile'),
  unlinkSync: readOnly('unlink'),
  rmSync: readOnly('rm'),
  access(path, mode, callback) {
    const cb = typeof mode === 'function' ? mode : callback;
    if (cb) cb(fsError('ENOENT', 'access', path));
  },
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};
