// res.sendFile for a file the server itself located (the built frontend, stored
// artwork, the corner model), by absolute path.
//
// Express 5's `send` applies its dotfiles rule ('ignore' by default) to every
// segment of the path it is given. Handed an absolute path, that includes the
// install's own directories: a database or checkout under ~/.local/share/... or
// a .claude/ worktree answered every request with a 404. Express 4's `send` only
// looked at the file name. Sending the name relative to its directory as `root`
// limits the check to the part below that directory, as before.
const path = require('path');

function sendFileAt(res, file, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  return res.sendFile(path.basename(file), { ...options, root: path.dirname(file) }, callback);
}

module.exports = { sendFileAt };
