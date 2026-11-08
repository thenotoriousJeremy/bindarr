// `path` inside the phone app: POSIX join/dirname/basename, the three the
// backend calls. The paths it builds only ever reach the fs stub, which has no
// files to find, and db.js, which hands the database name to the SQLite plugin.
'use strict';

function normalize(p) {
  const absolute = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (part !== '..' || !absolute) out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : (joined || '.');
}

function join(...parts) {
  const filtered = parts.filter(p => typeof p === 'string' && p !== '');
  return filtered.length ? normalize(filtered.join('/')) : '.';
}

function dirname(p) {
  const trimmed = String(p).replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  if (at === -1) return '.';
  return at === 0 ? '/' : trimmed.slice(0, at);
}

function basename(p, ext) {
  const base = String(p).replace(/\/+$/, '').split('/').pop();
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

function extname(p) {
  const base = basename(p);
  const at = base.lastIndexOf('.');
  return at > 0 ? base.slice(at) : '';
}

const resolve = (...parts) => {
  const joined = join(...parts);
  return joined.startsWith('/') ? joined : normalize(`/${joined}`);
};

module.exports = { join, dirname, basename, extname, resolve, normalize, sep: '/', delimiter: ':', posix: null };
module.exports.posix = module.exports;
