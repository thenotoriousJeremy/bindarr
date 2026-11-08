'use strict';

const performance = globalThis.performance;
if (!performance || typeof performance.now !== 'function') {
  throw new Error('performance.now is required in embedded mode');
}

module.exports = { performance };
