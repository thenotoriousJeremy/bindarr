// `npm test` in backend/: the unit suites, then the e2e suites — both, always.
//
// It was `node test/run.js && node test/e2e/run.js`, so a single failing unit file
// skipped every e2e suite and the run looked like one failure. Each runner prints
// its own summary; this only makes sure the second one runs regardless of the
// first, and that the exit code covers both.
//
// Not a *.test.js file on purpose: test/run.js would otherwise run it as a unit test.
const path = require('path');
const { spawnSync } = require('child_process');

const runners = [
  ['unit', path.join(__dirname, 'run.js')],
  ['e2e', path.join(__dirname, 'e2e', 'run.js')],
];

const failed = [];
for (const [name, file] of runners) {
  const { status } = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (status !== 0) failed.push(name);
}

if (failed.length) {
  console.error(`\nbackend: the ${failed.join(' and ')} tests failed.`);
  process.exit(1);
}
console.log('\nbackend: unit and e2e tests passed.');
