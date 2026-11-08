import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastRatio, parseHex, composite, themeTokens } from './contrast.js';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
const themes = themeTokens(css);
// WCAG AA for normal-size text.
const AA = 4.5;

test('contrastRatio matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000', '#fff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#fff', '#fff').toFixed(2), '1.00');
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(contrastRatio('#ffffff', '#777777'), contrastRatio('#777777', '#ffffff'));
});

test('composite paints rgba over its backdrop', () => {
  assert.deepEqual(composite('rgba(255, 255, 255, 0.5)', [0, 0, 0]), [127.5, 127.5, 127.5]);
  assert.deepEqual(composite('#102030', [0, 0, 0]), [16, 32, 48]);
});

test('every theme block is found', () => {
  for (const name of ['default', 'light', 'pokemon', 'mtg', 'lorcana', 'lcars']) {
    assert.ok(themes[name], `missing theme ${name}`);
  }
});

// Muted and secondary text sit on the page, on solid panels and on glass panels.
for (const [name, vars] of Object.entries(themes)) {
  for (const fg of ['text-primary', 'text-secondary', 'text-muted']) {
    test(`${name}: --${fg} is at least ${AA}:1 on every background`, () => {
      // A theme that leaves a token to :root inherits it.
      const pick = (key) => vars[key] ?? themes.default[key];
      const page = parseHex(pick('bg-primary'));
      const backgrounds = {
        'bg-primary': page,
        'bg-secondary': parseHex(pick('bg-secondary')),
        'bg-glass over bg-primary': composite(pick('bg-glass'), page),
      };
      for (const [bgName, bg] of Object.entries(backgrounds)) {
        assert.ok(bg, `${name}: unreadable --${bgName}`);
        const ratio = contrastRatio(parseHex(pick(fg)), bg);
        assert.ok(ratio >= AA, `${name}: --${fg} ${pick(fg)} on ${bgName} is ${ratio.toFixed(2)}:1`);
      }
    });
  }
}
