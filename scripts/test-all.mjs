// `npm test` from the repo root: every suite, every time, then one verdict.
//
// This used to be `npm test --prefix backend && npm test --prefix frontend`, with
// backend's own script `node test/run.js && node test/e2e/run.js`. So a single
// failing unit file skipped the e2e suites AND the whole frontend, and the run
// reported one failure for what might have been several — or hid that the rest
// were fine. Here each suite runs whatever happened to the one before it, and the
// exit code is non-zero if any of them failed.
//
// Each suite is a package's own npm script, so what runs here is exactly what
// `npm run <script>` runs inside that package; nothing is redefined.
//
//   node scripts/test-all.mjs              every suite
//   node scripts/test-all.mjs backend      only suites whose name contains "backend"
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: 'backend unit', dir: 'backend', script: 'test:unit' },
  { name: 'backend e2e', dir: 'backend', script: 'test:e2e' },
  { name: 'frontend utils', dir: 'frontend', script: 'test:utils' },
  { name: 'frontend locales', dir: 'frontend', script: 'check:locales' },
  { name: 'tcgcsv mirror', dir: '.', script: 'test:mirror' },
];

// Under `npm test` npm says where it lives, so it can be run with this same node
// and no shell. Run directly (`node scripts/test-all.mjs`), fall back to the npm on
// PATH through a shell, which is what finds npm.cmd on Windows. The script names
// are the fixed ones above, never input, so the one-string command is safe.
function runScript(dir, script) {
  const cwd = path.join(ROOT, dir);
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.(c?js|mjs)$/.test(npmCli)) {
    return spawnSync(process.execPath, [npmCli, 'run', script], { cwd, stdio: 'inherit' });
  }
  return spawnSync(`npm run ${script}`, { cwd, stdio: 'inherit', shell: true });
}

const filters = process.argv.slice(2).map(f => f.toLowerCase());
const selected = SUITES.filter(s => !filters.length || filters.some(f => s.name.includes(f)));
if (!selected.length) {
  console.error(`No suite matches ${filters.join(', ')}. Suites: ${SUITES.map(s => s.name).join(', ')}.`);
  process.exit(1);
}

const results = [];
for (const suite of selected) {
  console.log(`\n==================== ${suite.name} (npm run ${suite.script} in ${suite.dir}) ====================\n`);
  const started = Date.now();
  const { status, error } = runScript(suite.dir, suite.script);
  if (error) console.error(`Could not start ${suite.name}: ${error.message}`);
  results.push({ ...suite, ok: status === 0 && !error, seconds: (Date.now() - started) / 1000 });
}

const width = Math.max(...results.map(r => r.name.length));
console.log('\n==================== TEST SUMMARY ====================');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.seconds.toFixed(1)} s`);
}
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} suites failed: ${failed.map(r => r.name).join(', ')}.`);
  process.exit(1);
}
console.log(`\n${results.length === 1 ? 'The suite' : `All ${results.length} suites`} passed.`);
