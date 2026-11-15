// Runs every unit test in test/, discovered rather than listed.
//
// package.json used to name each file by hand. Ten test files had been added since
// that list was last touched — clientcrop, dbrename, pricehistory, scanfloor,
// scopedbuild, the three scryfall ones, version and setquery — so they sat in the
// repo passing nothing, for however many months. A test nobody runs is worse than
// no test: it reads as coverage on the way past.
//
// Non-recursive on purpose: test/e2e has its own runner (test/e2e/run.js), because
// those suites need a live server and a pinned admin password.
//
// Every file is a plain assert script run in a child process of its own, which is
// also the isolation the two tests that used to be invoked separately
// (bootstrapowner, scanlang) were getting. Exit 0 passed, exit 77 skipped (a test
// that needs what this install lacks, such as the scan models), anything else
// failed. A file that runs past the timeout is killed and counted as failed, so a
// hang costs minutes rather than the whole CI job.
//
//   node test/run.js                       every file
//   node test/run.js scanfloor fastdetector only files whose names contain one of these
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clearStaleTestFiles } = require('./tempFiles');

// The exit code a test uses to say it did not run (the automake convention).
const SKIP = 77;
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS) || 5 * 60 * 1000;

// Throwaway databases a previous run left behind. A stale one means the next test
// to draw that PID calls initDb against a database that ALREADY has an admin user
// and collection rows, and then fails an assertion about how many rows it can see.
// That is a test failure describing nothing but a dirty temp directory, which is
// the fastest way to teach people to ignore a suite.
clearStaleTestFiles();

const TEST_DIR = __dirname;
const filters = process.argv.slice(2);
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filters.length || filters.some(x => f.includes(x)))
  .sort();

if (!files.length) {
  console.error(filters.length
    ? `No test file in test/ matches ${filters.join(', ')}.`
    : 'No test files found in test/ — that is a broken checkout, not a pass.');
  process.exit(1);
}

const failed = [];
const skipped = [];
for (const file of files) {
  const started = Date.now();
  const { status, signal, error } = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    stdio: 'inherit',
    timeout: FILE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  let verdict;
  if (error && error.code === 'ETIMEDOUT') {
    verdict = `FAIL: ${file} (killed after ${FILE_TIMEOUT_MS / 1000} s)`;
    failed.push(file);
  } else if (status === 0) {
    verdict = `PASS: ${file} (${took})`;
  } else if (status === SKIP) {
    verdict = `SKIP: ${file}`;
    skipped.push(file);
  } else {
    verdict = `FAIL: ${file}${signal ? ` (${signal})` : ''}${error ? ` (${error.message})` : ''}`;
    failed.push(file);
  }
  console.log(verdict);
}

const ran = files.length - skipped.length;
console.log(`\n${ran - failed.length}/${ran} unit test files passed${skipped.length ? `, ${skipped.length} skipped` : ''}.`);
if (skipped.length) console.log(`Skipped (not run, not passed): ${skipped.join(', ')}`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
