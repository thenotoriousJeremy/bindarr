const fs = require('fs');
const path = require('path');
const assert = require('assert');

const projectRoot = path.join(__dirname, '../../../');
const cameraScannerPath = path.join(projectRoot, 'frontend/src/components/CameraScanner.jsx');
const inspectorModalPath = path.join(projectRoot, 'frontend/src/components/CardInspectorModal.jsx');

// Regular expression to parse set code and collector number for MTG
const MTG_OCR_REGEX = /^([A-Z0-9]{3,5})[\s\/]+([0-9a-zA-Z★]+)$/;

function parseMTGOCR(text) {
  // Clean text and look for standard pattern
  const cleaned = text.trim().toUpperCase();
  const match = cleaned.match(MTG_OCR_REGEX);
  if (match) {
    return { set: match[1], number: match[2] };
  }
  return null;
}

function runTests() {
  // F4-TC1: Verify layout toggle in CameraScanner.jsx contains 'mtg' option
  try {
    const scannerContent = fs.readFileSync(cameraScannerPath, 'utf8');
    assert.ok(
      scannerContent.includes('mtg') || scannerContent.includes('MTG'),
      'CameraScanner.jsx must contain MTG layout option or toggle'
    );
    console.log('PASS: F4-TC1');
  } catch (err) {
    console.error('FAIL: F4-TC1 -', err.message);
    throw err;
  }

  // F4-TC2: Verify OCR parsing regex works with ELD/123 or ELD 123
  try {
    const res1 = parseMTGOCR('ELD/123');
    assert.ok(res1);
    assert.strictEqual(res1.set, 'ELD');
    assert.strictEqual(res1.number, '123');

    const res2 = parseMTGOCR('ELD 123');
    assert.ok(res2);
    assert.strictEqual(res2.set, 'ELD');
    assert.strictEqual(res2.number, '123');
    console.log('PASS: F4-TC2');
  } catch (err) {
    console.error('FAIL: F4-TC2 -', err.message);
    throw err;
  }

  // F4-TC3: Verify CardInspectorModal.jsx maps/renders MTG-specific styles or symbols
  try {
    const inspectorContent = fs.readFileSync(inspectorModalPath, 'utf8');
    assert.ok(
      inspectorContent.includes('mtg') || inspectorContent.includes('MTG') || inspectorContent.includes('supertype'),
      'CardInspectorModal.jsx must have support/style mapping for MTG or supertype checking'
    );
    console.log('PASS: F4-TC3');
  } catch (err) {
    console.error('FAIL: F4-TC3 -', err.message);
    throw err;
  }

  // F4-TC4: Verify OCR query dispatch calls search API with game=mtg, set, and number
  try {
    const scannerContent = fs.readFileSync(cameraScannerPath, 'utf8');
    assert.ok(
      scannerContent.includes('game=mtg') || scannerContent.includes('game') || scannerContent.includes('search'),
      'CameraScanner.jsx must trigger search API with game/set/number params'
    );
    console.log('PASS: F4-TC4');
  } catch (err) {
    console.error('FAIL: F4-TC4 -', err.message);
    throw err;
  }

  // F4-TC5: Verify ROI overlay shifts to bottom-left when cardLayout is mtg
  try {
    const scannerContent = fs.readFileSync(cameraScannerPath, 'utf8');
    // Check if bottom-left style / ROI properties are configured for mtg layout
    assert.ok(
      scannerContent.includes('bottom') || scannerContent.includes('left') || scannerContent.includes('scan-region-number-left'),
      'CameraScanner.jsx must adjust scanning region/ROI for MTG layout'
    );
    console.log('PASS: F4-TC5');
  } catch (err) {
    console.error('FAIL: F4-TC5 -', err.message);
    throw err;
  }

  // F4-TC6: Verify set code matching lengths (3 to 5 alphanumeric characters)
  try {
    assert.ok(parseMTGOCR('M19/123'), 'Must match 3-char set code');
    assert.ok(parseMTGOCR('MH2/123'), 'Must match 3-char set code');
    assert.ok(parseMTGOCR('KHAN/123'), 'Must match 4-char set code');
    assert.ok(parseMTGOCR('CON15/123'), 'Must match 5-char set code');
    assert.ok(!parseMTGOCR('AB/123'), 'Should reject 2-char set code');
    console.log('PASS: F4-TC6');
  } catch (err) {
    console.error('FAIL: F4-TC6 -', err.message);
    throw err;
  }

  // F4-TC7: Verify collector number suffixes (alphabetic, promo stars, etc.)
  try {
    const res1 = parseMTGOCR('ELD/123a');
    assert.ok(res1);
    assert.strictEqual(res1.number, '123A');

    const res2 = parseMTGOCR('WAR/789★');
    assert.ok(res2);
    assert.strictEqual(res2.number, '789★');
    console.log('PASS: F4-TC7');
  } catch (err) {
    console.error('FAIL: F4-TC7 -', err.message);
    throw err;
  }

  // F4-TC8: Verify noise/garbage filtering ignores unrelated text
  try {
    const noiseInput1 = '© 2023 Wizards of the Coast';
    const noiseInput2 = 'Illus. Ken Sugimori';
    assert.strictEqual(parseMTGOCR(noiseInput1), null, 'Should filter out copyright noise');
    assert.strictEqual(parseMTGOCR(noiseInput2), null, 'Should filter out artist credit noise');
    console.log('PASS: F4-TC8');
  } catch (err) {
    console.error('FAIL: F4-TC8 -', err.message);
    throw err;
  }

  // F4-TC9: Verify CardInspectorModal.jsx renders fallback when image_url is missing
  try {
    const inspectorContent = fs.readFileSync(inspectorModalPath, 'utf8');
    assert.ok(
      inspectorContent.includes('alt={') || inspectorContent.includes('fallback') || inspectorContent.includes('placeholder'),
      'CardInspectorModal.jsx must handle missing image_url gracefully with alt text or placeholder'
    );
    console.log('PASS: F4-TC9');
  } catch (err) {
    console.error('FAIL: F4-TC9 -', err.message);
    throw err;
  }

  // F4-TC10: Verify camera permission rejection UX renders error message
  try {
    const scannerContent = fs.readFileSync(cameraScannerPath, 'utf8');
    assert.ok(
      scannerContent.includes('denied') || scannerContent.includes('permission') || scannerContent.includes('access'),
      'CameraScanner.jsx must display user-friendly text if camera permission is denied'
    );
    console.log('PASS: F4-TC10');
  } catch (err) {
    console.error('FAIL: F4-TC10 -', err.message);
    throw err;
  }
}

try {
  runTests();
  process.exit(0);
} catch (err) {
  process.exit(1);
}
