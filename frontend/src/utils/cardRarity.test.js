// Rarity tiers and badge labels across the three games.
// Run: `node --test src/utils/cardRarity.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRarityTier, getRarityBadgeLabel, getRarityRank } from './cardRarity.js';

test('Pokémon rarities keep their tiers', () => {
  assert.equal(getRarityTier('Common'), 'common');
  assert.equal(getRarityTier('Uncommon'), 'uncommon');
  assert.equal(getRarityTier('Rare Holo'), 'rare');
  assert.equal(getRarityTier('Special Illustration Rare'), 'top');
  assert.equal(getRarityBadgeLabel('Double Rare'), 'DR');
});

test("Magic's mythic is top tier, not common", () => {
  assert.equal(getRarityTier('Mythic'), 'top');
  assert.equal(getRarityBadgeLabel('Mythic'), 'MYTHIC');
  assert.equal(getRarityTier('Rare'), 'rare');
});

test("Lorcana's top rarities are top tier with their own labels", () => {
  for (const [rarity, label] of [['Legendary', 'LEG'], ['Enchanted', 'ENCH'], ['Epic', 'EPIC'], ['Iconic', 'ICONIC']]) {
    assert.equal(getRarityTier(rarity), 'top', rarity);
    assert.equal(getRarityBadgeLabel(rarity), label, rarity);
  }
  assert.equal(getRarityTier('Super Rare'), 'rare');
  assert.equal(getRarityBadgeLabel('Super Rare'), 'RARE');
});

test("Riftbound's Showcase is top tier with its own label", () => {
  assert.equal(getRarityTier('Showcase'), 'top');
  assert.equal(getRarityBadgeLabel('Showcase'), 'SHOW');
  assert.equal(getRarityTier('Epic'), 'top');
});

// The sort rank is shared/cardSort.mjs, the table the backend files by. Lorcana's
// and Riftbound's top rarities used to have no rank at all, so they sorted below
// Common, and Super Rare read as plain Rare.
test('rarity ranks put Lorcana and Riftbound rarities in order', () => {
  const byRank = (list) => [...list].sort((a, b) => getRarityRank(b) - getRarityRank(a));
  assert.deepEqual(byRank(['Common', 'Legendary', 'Super Rare', 'Enchanted', 'Rare', 'Iconic', 'Epic', 'Uncommon']),
    ['Iconic', 'Enchanted', 'Epic', 'Legendary', 'Super Rare', 'Rare', 'Uncommon', 'Common']);
  assert.deepEqual(byRank(['Rare', 'Common', 'Showcase', 'Uncommon', 'Epic']), ['Showcase', 'Epic', 'Rare', 'Uncommon', 'Common']);
  assert.ok(getRarityRank('Common') > getRarityRank('Something Unknown'), 'an unknown rarity still sorts before Common');
});
