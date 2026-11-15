import test from 'node:test';
import assert from 'node:assert/strict';
import { typeChartColor, CHART_PALETTE } from './dashboardColors.js';
import { CARD_COLORS } from './cardColors.js';

test('a type slice takes the shared card-category colour, whatever its case', () => {
  for (const name of ['Grass', 'Blue', 'Amethyst', 'Colorless']) {
    assert.equal(typeChartColor(name, 0), CARD_COLORS[name], name);
    assert.equal(typeChartColor(name.toUpperCase(), 3), CARD_COLORS[name], `${name} upper case`);
  }
});

test("Magic's land slice keeps its own colour", () => {
  assert.equal(typeChartColor('Land', 0), '#d97706');
  assert.equal(typeChartColor('land', 5), '#d97706');
});

test('an unknown type falls back to the palette by index, never one grey', () => {
  assert.equal(typeChartColor('Mystery', 0), CHART_PALETTE[0]);
  assert.equal(typeChartColor('Mystery', 1), CHART_PALETTE[1]);
  assert.equal(typeChartColor('Mystery', CHART_PALETTE.length), CHART_PALETTE[0]);
  assert.equal(typeChartColor(undefined, 2), CHART_PALETTE[2]);
});
