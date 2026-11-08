// Rarity tiers and badge labels across the three games.
// Run: `node --test src/utils/cardRarity.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRarityTier, getRarityBadgeLabel } from './cardRarity.js';

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
