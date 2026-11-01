import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../scripts/run-suite.mjs', import.meta.url));

test('the launcher exits 2 with its usage and runs nothing for an argument outside its closed set', () => {
  const r = spawnSync(process.execPath, [launcher, 'fast', '--import=x'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^usage: node scripts\/run-suite\.mjs \[fast \[boundary \.\.\.\]\]/);
});

// A copy of the launcher in a temp repo whose ESLint and tsc bin scripts are fakes that log their step and exit with the
// code a case gives; its one test file logs `tests`. Each step appends to steps.log, so the log is what ran, in order.
function launcherCopy(t, { eslint = 0, tsc = 0, installed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-run-suite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test', 'contract'), { recursive: true });
  mkdirSync(join(root, 'test', 'unit'));
  copyFileSync(launcher, join(root, 'scripts', 'run-suite.mjs'));
  const step = (name, code) => `require('node:fs').appendFileSync('steps.log', '${name}\\n'); process.exit(${code});\n`;
  if (installed) {
    mkdirSync(join(root, 'node_modules', 'eslint', 'bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), step('eslint', eslint));
    writeFileSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), step('tsc', tsc));
  }
  writeFileSync(
    join(root, 'test', 'unit', 'steps.test.mjs'),
    "import { appendFileSync } from 'node:fs';\nappendFileSync('steps.log', 'tests\\n');\n",
  );
  // The runner running this file sets NODE_TEST_CONTEXT, which would make the copy's own node --test run no file.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (argv) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'run-suite.mjs'), ...argv], { encoding: 'utf8', env });
  const steps = () => (existsSync(join(root, 'steps.log')) ? readFileSync(join(root, 'steps.log'), 'utf8') : '');
  return { run, steps };
}

for (const [stage, argv] of [
  ['full', []],
  ['fast', ['fast']],
]) {
  test(`the ${stage} stage runs lint, the type check and the tests in that order and exits 0`, (t) => {
    const copy = launcherCopy(t);
    const r = copy.run(argv);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(copy.steps(), 'eslint\ntsc\ntests\n');
  });

  test(`a failing lint step stops the ${stage} stage with its exit code before the type check and the tests`, (t) => {
    const copy = launcherCopy(t, { eslint: 3 });
    assert.equal(copy.run(argv).status, 3);
    assert.equal(copy.steps(), 'eslint\n');
  });

  test(`a failing type check stops the ${stage} stage with its exit code before the tests`, (t) => {
    const copy = launcherCopy(t, { tsc: 2 });
    assert.equal(copy.run(argv).status, 2);
    assert.equal(copy.steps(), 'eslint\ntsc\n');
  });

  test(`the ${stage} stage without node_modules says to run npm ci and runs nothing`, (t) => {
    const copy = launcherCopy(t, { installed: false });
    const r = copy.run(argv);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /node_modules\/eslint\/bin\/eslint\.js and node_modules\/typescript\/bin\/tsc not found: run npm ci first/,
    );
    assert.equal(copy.steps(), '');
  });
}
