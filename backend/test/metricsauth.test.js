const assert = require('assert');
const { metricsRequestAuthorized } = require('../src/utils/metricsAuth');

// No token configured: the listener stays open, as it was before the option existed.
assert.strictEqual(metricsRequestAuthorized(undefined, ''), true);
assert.strictEqual(metricsRequestAuthorized('Bearer anything', undefined), true);

// Token configured: only the exact bearer value passes.
assert.strictEqual(metricsRequestAuthorized('Bearer s3cret', 's3cret'), true);
assert.strictEqual(metricsRequestAuthorized('bearer s3cret', 's3cret'), true, 'scheme is case-insensitive');
assert.strictEqual(metricsRequestAuthorized('Bearer s3cre', 's3cret'), false);
assert.strictEqual(metricsRequestAuthorized('Bearer s3cret2', 's3cret'), false);
assert.strictEqual(metricsRequestAuthorized('Basic s3cret', 's3cret'), false);
assert.strictEqual(metricsRequestAuthorized('s3cret', 's3cret'), false);
assert.strictEqual(metricsRequestAuthorized(undefined, 's3cret'), false);
assert.strictEqual(metricsRequestAuthorized('', 's3cret'), false);

console.log('metricsauth.test.js: all assertions passed');
