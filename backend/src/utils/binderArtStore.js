const fs = require('fs');
const path = require('path');
const db = require('../db');

// Binder artwork files, kept beside the database like card art so they ride the
// same persistent volume. One directory per user, one file per artwork row,
// named by numeric ids only: nothing the client sends becomes part of a path.
const ROOT = path.join(path.dirname(db.dbPath), 'binder-art');

// 12 MB covers a phone photo or a large scan. The long edge is capped at what a
// two-page spread of 3-wide pages needs at print resolution: about 400 mm at
// 300 dpi is ~4700 px, so 6000 leaves headroom without storing a 50 MP original.
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 6000;
// Decoding is bounded too, so a tiny file that claims to be 100k x 100k is
// refused by sharp before it allocates the pixels.
const MAX_INPUT_PIXELS = 16000 * 16000;
const FORMATS = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function badImage(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function fileFor(userId, artworkId) {
  const user = Number(userId);
  const id = Number(artworkId);
  if (!Number.isInteger(user) || user <= 0 || !Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid artwork id');
  }
  return path.join(ROOT, String(user), String(id));
}

// Validate and re-encode an upload. Re-encoding is the point, as with card art:
// the file served back is pixels sharp produced, never the uploaded bytes, and
// EXIF (a phone photo's GPS position, on a page that may be shared publicly) is
// dropped. rotate() with no argument applies the EXIF orientation first.
async function prepare(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badImage('Upload a JPEG, PNG or WebP image.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw badImage('That image is over 12 MB.');
  const sharp = require('sharp');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw badImage('That file is not a readable image.');
  }
  const mime = FORMATS[meta.format];
  if (!mime || !meta.width || !meta.height) throw badImage('Upload a JPEG, PNG or WebP image.');

  let pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  if (meta.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 92 });
  else if (meta.format === 'webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.png();
  let out;
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    throw badImage('That file is not a readable image.');
  }
  return { data: out.data, mime, width: out.info.width, height: out.info.height, bytes: out.data.length };
}

function write(userId, artworkId, data) {
  const file = fileFor(userId, artworkId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

// Absolute path of the stored file, or null when it is missing on disk.
function resolve(userId, artworkId) {
  const file = fileFor(userId, artworkId);
  return fs.existsSync(file) ? file : null;
}

function remove(userId, artworkId) {
  try { fs.unlinkSync(fileFor(userId, artworkId)); } catch { /* already gone */ }
}

function removeUser(userId) {
  const user = Number(userId);
  if (!Number.isInteger(user) || user <= 0) return;
  fs.rmSync(path.join(ROOT, String(user)), { recursive: true, force: true });
}

function presentLayer(row) {
  let mask = [];
  try { mask = JSON.parse(row.mask || '[]'); } catch { mask = []; }
  return {
    compartment_id: row.compartment_id,
    artwork_id: row.artwork_id,
    x_mm: row.x_mm,
    y_mm: row.y_mm,
    width_mm: row.width_mm,
    rotation_deg: row.rotation_deg,
    spread: row.spread === 1,
    mask: Array.isArray(mask) ? mask : [],
    pocket_w_mm: row.pocket_w_mm,
    pocket_h_mm: row.pocket_h_mm,
    gap_mm: row.gap_mm,
    width: row.width,
    height: row.height,
  };
}

// Every layer on one container's pages. The owner check is the join on
// locations.user_id, so the share route and the owner route read the same rows
// through the same filter.
async function layersForLocation(locationId, ownerId) {
  const rows = await db.all(
    `SELECT l.*, a.width, a.height
       FROM binder_art_layers l
       JOIN compartments c ON c.id = l.compartment_id
       JOIN locations loc ON loc.id = c.location_id
       JOIN binder_artwork a ON a.id = l.artwork_id AND a.user_id = l.user_id
      WHERE loc.id = ? AND loc.user_id = ? AND l.user_id = ?
      ORDER BY c.idx ASC`,
    [locationId, ownerId, ownerId]
  );
  return rows.map(presentLayer);
}

// Drop an artwork no layer uses any more, row and file.
async function dropIfUnused(userId, artworkId) {
  if (!artworkId) return;
  const used = await db.get(`SELECT 1 FROM binder_art_layers WHERE artwork_id = ? LIMIT 1`, [artworkId]);
  if (used) return;
  await db.run(`DELETE FROM binder_artwork WHERE id = ? AND user_id = ?`, [artworkId, userId]);
  remove(userId, artworkId);
}

module.exports = {
  prepare, write, resolve, remove, removeUser, presentLayer, layersForLocation, dropIfUnused,
  ROOT, MAX_UPLOAD_BYTES,
};
