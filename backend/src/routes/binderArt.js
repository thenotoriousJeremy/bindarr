const express = require('express');
const db = require('../db');
const store = require('../utils/binderArtStore');
const { sendFileAt } = require('../utils/sendFileAt');

const router = express.Router();

// Custom artwork for binder pages (issue #104). A picture is uploaded once, then
// a layer places it on a page in millimetres and lists the pockets that show it.
// Everything here is scoped to req.user.id; the public read lives in shared.js
// behind the same share_locations gate as the shared container itself.

// Unreferenced uploads are swept after a day: an upload is unreferenced until
// the editor saves its layer, so a fresh one must survive long enough for that.
const ORPHAN_AGE = '-1 day';
// A ceiling on what one account can park on disk. Each layer references one
// artwork, so this is far above anything a real binder needs.
const MAX_ARTWORKS_PER_USER = 200;
// Mask coordinates are bounded by the widest page the binder UI can draw
// (MAX_PAGE_COLUMNS in storage.js is 12) with room for tall pages.
const MAX_GRID = 64;

const rawImage = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: store.MAX_UPLOAD_BYTES,
});

// The body parser's own 413 would otherwise reach the global handler, whose
// message is about import batches.
function parseImage(req, res, next) {
  rawImage(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That image is over 12 MB.' });
    return res.status(400).json({ error: 'Could not read that upload.' });
  });
}

const posInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function finiteIn(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Validate a layer body. Returns { layer } or { error }.
function parseLayer(body) {
  const b = body || {};
  const artworkId = posInt(b.artwork_id);
  if (!artworkId) return { error: 'Choose an image first.' };
  const x = finiteIn(b.x_mm, -5000, 5000);
  const y = finiteIn(b.y_mm, -5000, 5000);
  const width = finiteIn(b.width_mm, 5, 5000);
  const rotationRaw = Number(b.rotation_deg ?? 0);
  if (x == null || y == null || width == null || !Number.isFinite(rotationRaw)) {
    return { error: 'The artwork position or size is out of range.' };
  }
  const rotation = ((rotationRaw % 360) + 360) % 360;
  const pocketW = finiteIn(b.pocket_w_mm ?? 63, 20, 200);
  const pocketH = finiteIn(b.pocket_h_mm ?? 88, 20, 200);
  const gap = finiteIn(b.gap_mm ?? 0, 0, 30);
  if (pocketW == null || pocketH == null || gap == null) {
    return { error: 'Pocket size must be 20 to 200 mm, and spacing 0 to 30 mm.' };
  }
  const spread = b.spread ? 1 : 0;
  if (!Array.isArray(b.mask) || b.mask.length > MAX_GRID * MAX_GRID * 2) {
    return { error: 'Choose the pockets that show the artwork.' };
  }
  const seen = new Set();
  const mask = [];
  for (const entry of b.mask) {
    const side = entry && entry.side === 'right' ? 'right' : 'left';
    const row = Number(entry && entry.row);
    const col = Number(entry && entry.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= MAX_GRID || col >= MAX_GRID) {
      return { error: 'A pocket on the artwork is out of range.' };
    }
    if (side === 'right' && !spread) continue; // no right page without a spread
    const key = `${side}:${row}:${col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mask.push({ side, row, col });
  }
  return { layer: { artworkId, x, y, width, rotation, spread, mask, pocketW, pocketH, gap } };
}

// The page, only if it is in one of this user's containers.
function ownedCompartment(compartmentId, userId) {
  return db.get(
    `SELECT c.id, c.location_id FROM compartments c
       JOIN locations l ON l.id = c.location_id
      WHERE c.id = ? AND l.user_id = ?`,
    [compartmentId, userId]
  );
}

router.post('/binder-art', parseImage, async (req, res) => {
  const userId = req.user.id;
  try {
    const prepared = await store.prepare(req.body);

    const stale = await db.all(
      `SELECT a.id FROM binder_artwork a
        WHERE a.user_id = ? AND a.created_at < datetime('now', ?)
          AND NOT EXISTS (SELECT 1 FROM binder_art_layers l WHERE l.artwork_id = a.id)`,
      [userId, ORPHAN_AGE]
    );
    for (const row of stale) await store.dropIfUnused(userId, row.id);

    const { n } = await db.get(`SELECT COUNT(*) AS n FROM binder_artwork WHERE user_id = ?`, [userId]);
    if (n >= MAX_ARTWORKS_PER_USER) {
      return res.status(409).json({ error: 'You have too many artwork images stored. Remove some from your binders first.' });
    }

    const inserted = await db.run(
      `INSERT INTO binder_artwork (user_id, mime, width, height, bytes) VALUES (?, ?, ?, ?, ?)`,
      [userId, prepared.mime, prepared.width, prepared.height, prepared.bytes]
    );
    try {
      store.write(userId, inserted.lastID, prepared.data);
    } catch (err) {
      await db.run(`DELETE FROM binder_artwork WHERE id = ? AND user_id = ?`, [inserted.lastID, userId]);
      throw err;
    }
    res.status(201).json({
      artwork: { id: inserted.lastID, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.bytes },
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Binder artwork upload failed:', error.message);
    res.status(500).json({ error: 'Could not store that image.' });
  }
});

router.get('/binder-art/:id/image', async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Artwork not found' });
  try {
    const row = await db.get(`SELECT id, mime FROM binder_artwork WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    const file = row && store.resolve(req.user.id, row.id);
    if (!file) return res.status(404).json({ error: 'Artwork not found' });
    res.set('Content-Type', row.mime);
    res.set('Cache-Control', 'private, max-age=3600');
    sendFileAt(res, file);
  } catch (error) {
    console.error('Binder artwork read failed:', error.message);
    res.status(500).json({ error: 'Could not read that image.' });
  }
});

router.get('/locations/:id/binder-art', async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(404).json({ error: 'Container not found' });
  try {
    const location = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Container not found' });
    res.json({ layers: await store.layersForLocation(location.id, req.user.id) });
  } catch (error) {
    console.error('Binder artwork layers failed:', error.message);
    res.status(500).json({ error: 'Could not read the artwork on this binder.' });
  }
});

router.put('/compartments/:id/binder-art', async (req, res) => {
  const userId = req.user.id;
  const compartmentId = posInt(req.params.id);
  if (!compartmentId) return res.status(404).json({ error: 'Page not found' });
  const parsed = parseLayer(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const l = parsed.layer;
  try {
    const compartment = await ownedCompartment(compartmentId, userId);
    if (!compartment) return res.status(404).json({ error: 'Page not found' });
    const artwork = await db.get(`SELECT id FROM binder_artwork WHERE id = ? AND user_id = ?`, [l.artworkId, userId]);
    if (!artwork) return res.status(400).json({ error: 'Artwork not found' });

    const previous = await db.get(`SELECT artwork_id FROM binder_art_layers WHERE compartment_id = ?`, [compartmentId]);
    await db.run(
      `INSERT INTO binder_art_layers
         (user_id, compartment_id, artwork_id, x_mm, y_mm, width_mm, rotation_deg, spread, mask, pocket_w_mm, pocket_h_mm, gap_mm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(compartment_id) DO UPDATE SET
         artwork_id = excluded.artwork_id, x_mm = excluded.x_mm, y_mm = excluded.y_mm,
         width_mm = excluded.width_mm, rotation_deg = excluded.rotation_deg, spread = excluded.spread,
         mask = excluded.mask, pocket_w_mm = excluded.pocket_w_mm, pocket_h_mm = excluded.pocket_h_mm,
         gap_mm = excluded.gap_mm, updated_at = CURRENT_TIMESTAMP`,
      [userId, compartmentId, artwork.id, l.x, l.y, l.width, l.rotation, l.spread, JSON.stringify(l.mask), l.pocketW, l.pocketH, l.gap]
    );
    if (previous && previous.artwork_id !== artwork.id) await store.dropIfUnused(userId, previous.artwork_id);

    const layers = await store.layersForLocation(compartment.location_id, userId);
    res.json({ layer: layers.find(row => row.compartment_id === compartmentId) || null });
  } catch (error) {
    console.error('Binder artwork save failed:', error.message);
    res.status(500).json({ error: 'Could not save that artwork.' });
  }
});

router.delete('/compartments/:id/binder-art', async (req, res) => {
  const userId = req.user.id;
  const compartmentId = posInt(req.params.id);
  if (!compartmentId) return res.status(404).json({ error: 'Page not found' });
  try {
    const layer = await db.get(
      `SELECT artwork_id FROM binder_art_layers WHERE compartment_id = ? AND user_id = ?`,
      [compartmentId, userId]
    );
    if (!layer) return res.status(404).json({ error: 'No artwork on this page' });
    await db.run(`DELETE FROM binder_art_layers WHERE compartment_id = ? AND user_id = ?`, [compartmentId, userId]);
    await store.dropIfUnused(userId, layer.artwork_id);
    res.json({ success: true });
  } catch (error) {
    console.error('Binder artwork delete failed:', error.message);
    res.status(500).json({ error: 'Could not remove that artwork.' });
  }
});

module.exports = router;
module.exports.parseLayer = parseLayer;
