const express = require('express');
const db = require('../db');
const cardArt = require('../cardArt');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Reads are unauthenticated on purpose. A shared collection (/api/shared/:token)
// is a public page that renders card images, so gating art behind a session would
// break exactly the view that has no session. Nothing here is user data: it is
// card art, keyed by a public card id.

// Which cards have art. Fetched once by the frontend so a grid of 500 cards does
// not fire 500 speculative image requests to find out.
router.get('/index', (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.json({ ids: cardArt.listIds() });
  } catch (error) {
    console.error('Failed to list card art:', error.message);
    res.json({ ids: [] }); // a broken index must not blank every card image
  }
});

// The art itself. must-revalidate rather than a long max-age: replacing art is a
// normal thing to do here, and a stale year-long cache would hide the fix.
router.get('/:cardId.png', (req, res) => {
  const file = cardArt.resolve(req.params.cardId);
  if (!file) return res.status(404).json({ error: 'No art for this card' });
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(file);
});

// Everything below changes files on disk. Admin-only: the art is instance-wide
// and shown to every user (and on public share pages), so a member replacing it
// would be editing what everybody else sees.
router.use(authenticateToken, requireAdmin);

// Upload art for a card. Body: { image: "data:image/png;base64,..." }.
router.post('/:cardId', async (req, res) => {
  const { cardId } = req.params;
  if (!cardArt.isValidId(cardId)) {
    return res.status(400).json({ error: 'Invalid card id' });
  }
  try {
    // Only cards the instance actually knows about. Without this the endpoint is
    // an open write-anything-shaped-like-an-id bucket, and the art would never be
    // displayed anyway since nothing references that id.
    const known = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
    if (!known) return res.status(404).json({ error: 'Unknown card' });

    const raw = String(req.body?.image || '');
    const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
    if (!b64) return res.status(400).json({ error: 'No image supplied' });

    const buffer = Buffer.from(b64, 'base64');
    const saved = await cardArt.save(cardId, buffer);
    res.json({ success: true, url: `/api/card-art/${cardId}.png`, ...saved });
  } catch (error) {
    console.error('Card art upload failed:', error.message);
    // The sharp/decoder detail stays in the log: it names internals, not anything
    // the uploader can act on.
    res.status(400).json({ error: 'Could not read that image' });
  }
});

// Drop this instance's copy, falling back to bundled art if the repo has some.
router.delete('/:cardId', (req, res) => {
  try {
    const removed = cardArt.remove(req.params.cardId);
    if (!removed) return res.status(404).json({ error: 'No uploaded art for this card' });
    res.json({ success: true, hasBundled: !!cardArt.resolve(req.params.cardId) });
  } catch (error) {
    console.error('Card art delete failed:', error.message);
    res.status(500).json({ error: 'Could not remove that art' });
  }
});

module.exports = router;
