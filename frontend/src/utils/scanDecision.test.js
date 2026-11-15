// components/scanner/scanDecision.js, tested here because the test runner reads
// src/utils.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDecision, sameCard, sameNumber, rankByScore } from '../components/scanner/scanDecision.js';
import { SCAN_MATCH_MIN_SCORE, SCAN_MATCH_MIN_INLIERS } from '../components/scanner/scanConstants.js';

const cand = (name, set, number, score, inliers) => ({ name, set, number, score, inliers });

test('a clear embedding match is filed', () => {
  const d = scanDecision({ candidates: [cand('Pikachu', 'sv1', '25', 0.9), cand('Raichu', 'sv1', '26', 0.6)], verified: false });
  assert.equal(d.confident, true);
  assert.equal(d.confidentPick, true);
  assert.equal(d.top.name, 'Pikachu');
});

test('below the score gate, or with nothing at all, it asks', () => {
  const low = scanDecision({ candidates: [cand('Pikachu', 'sv1', '25', SCAN_MATCH_MIN_SCORE - 0.01)], verified: false });
  assert.equal(low.confident, false);
  assert.equal(low.confidentPick, false);
  const none = scanDecision({ candidates: [], verified: false });
  assert.equal(none.top, null);
  assert.equal(none.confidentPick, false);
});

test('ORB answers gate on inliers instead of the cosine', () => {
  const enough = scanDecision({ candidates: [cand('Island', 'm19', '264', 0, SCAN_MATCH_MIN_INLIERS)], verified: true });
  assert.equal(enough.confidentPick, true);
  const few = scanDecision({ candidates: [cand('Island', 'm19', '264', 0.99, SCAN_MATCH_MIN_INLIERS - 1)], verified: true });
  assert.equal(few.confidentPick, false);
});

test('two printings of one card that nearly tie go to the picker', () => {
  const d = scanDecision({ candidates: [cand('Island', 'm19', '264', 0.9), cand('Island', 'dom', '250', 0.89)], verified: false });
  assert.equal(d.ambiguousPrinting, true);
  assert.equal(d.confidentPick, false);
  // ORB: within 70% of the top's inliers.
  const orb = scanDecision({ candidates: [cand('Island', 'm19', '264', 0, 20), cand('Island', 'dom', '250', 0, 14)], verified: true });
  assert.equal(orb.ambiguousPrinting, true);
  // Different cards are not a printing question.
  const other = scanDecision({ candidates: [cand('Island', 'm19', '264', 0, 20), cand('Swamp', 'm19', '268', 0, 19)], verified: true });
  assert.equal(other.ambiguousPrinting, false);
});

test("the server's ambiguousPrinting flag wins; without it the local check decides (PROV-10)", () => {
  const clear = [cand('Lightning Bolt', 'm10', '146', 0.95), cand('Shock', 'm19', '156', 0.5)];
  assert.equal(scanDecision({ candidates: clear, verified: false }).confidentPick, true, 'an older server sends no flag');
  const flagged = scanDecision({ candidates: clear, verified: false, ambiguousPrinting: true });
  assert.equal(flagged.ambiguousPrinting, true);
  assert.equal(flagged.confidentPick, false);
  assert.equal(scanDecision({ candidates: clear, verified: false, ambiguousPrinting: false }).confidentPick, true);
  assert.equal(scanDecision({ candidates: clear, verified: false, ambiguousPrinting: 'yes' }).confidentPick, true, 'only a real true counts');
});

test('a narrow embedding margin asks, whatever the names', () => {
  const d = scanDecision({ candidates: [cand('Pikachu', 'sv1', '25', 0.88), cand('Pichu', 'sv2', '30', 0.87)], verified: false });
  assert.equal(d.lowMargin, true);
  assert.equal(d.confidentPick, false);
});

test('a card the catalog does not know is never filed automatically', () => {
  const d = scanDecision({ candidates: [cand('Pikachu', 'sv1', '25', 0.95), cand('Raichu', 'sv1', '26', 0.5)], verified: false, notInCatalog: true });
  assert.equal(d.confident, true);
  assert.equal(d.confidentPick, false);
});

test('sameCard matches by set and number, leading zeros aside', () => {
  assert.equal(sameNumber('013', '13'), true);
  assert.equal(sameNumber('', ''), false);
  assert.equal(sameCard({ number: '013', set_id: 'SV1' }, { number: '13', set: 'sv1' }), true);
  assert.equal(sameCard({ number: '13', set_id: 'x', set_name: 'Base Set' }, { number: '13', set: 'base set' }), true);
  assert.equal(sameCard({ number: '14', set_id: 'sv1' }, { number: '13', set: 'sv1' }), false);
  assert.equal(sameCard(null, { number: '13', set: 'sv1' }), false);
});

test('search results rank by score, then by having art', () => {
  const ranked = rankByScore([
    { id: 'a', score: 0.2 }, { id: 'b' }, { id: 'c', score: 0.9 }, { id: 'd', image_url: 'x' },
  ]);
  assert.deepEqual(ranked.map(r => r.id), ['c', 'a', 'd', 'b']);
});
