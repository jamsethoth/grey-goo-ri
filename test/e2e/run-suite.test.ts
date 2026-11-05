import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tempDirectory from '../support/temp-directory.ts';

const launcher = fileURLToPath(new URL('../../scripts/run-suite.ts', import.meta.url));

test('the launcher exits 2 with its usage and runs nothing for an argument outside its closed set', () => {
  const result = spawnSync(process.execPath, [launcher, 'fast', '--import=x'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^usage: node scripts\/run-suite\.ts \[fast \[boundary \.\.\.\]\]/);
});

test('the launcher exits 2 with its usage and runs nothing for an argument after check', (t) => {
  const copy = launcherCopy(t);
  const result = copy.run(['check', 'git']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(
    result.stderr,
    /^usage: node scripts\/run-suite\.ts \[fast \[boundary \.\.\.\]\]\n\s+node scripts\/run-suite\.ts check\n/,
  );
  assert.equal(copy.steps(), '');
});

// A copy of the launcher in a temp repo whose Prettier, ESLint and tsc bin scripts are fakes that log their step and
// exit with the code a case gives; its one test file logs `tests`. Each step appends to steps.log, so the log is what
// ran, in order.
function launcherCopy(t: TestContext, { prettier = 0, eslint = 0, tsc = 0, installed = true } = {}) {
  const root = tempDirectory.tempDirectory(t, 'gg-run-suite-');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test', 'contract'), { recursive: true });
  mkdirSync(join(root, 'test', 'unit'));
  copyFileSync(launcher, join(root, 'scripts', 'run-suite.ts'));
  const step = (name: string, code: number) =>
    `require('node:fs').appendFileSync('steps.log', '${name}\\n'); process.exit(${code});\n`;
  if (installed) {
    mkdirSync(join(root, 'node_modules', 'prettier', 'bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'eslint', 'bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'), step('prettier', prettier));
    writeFileSync(join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), step('eslint', eslint));
    writeFileSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), step('tsc', tsc));
  }
  writeFileSync(
    join(root, 'test', 'unit', 'steps.test.mjs'),
    "import { appendFileSync } from 'node:fs';\nappendFileSync('steps.log', 'tests\\n');\n",
  );
  // The runner running this file sets NODE_TEST_CONTEXT, which would make the copy's own node --test run no file.
  const { NODE_TEST_CONTEXT: _runnerContext, ...env } = process.env;
  const run = (argv: string[]) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'run-suite.ts'), ...argv], { encoding: 'utf8', env });
  const steps = () => (existsSync(join(root, 'steps.log')) ? readFileSync(join(root, 'steps.log'), 'utf8') : '');
  return { run, steps };
}

test('the check stage runs the format check, lint and the type check in that order, no tests, and exits 0', (t) => {
  const copy = launcherCopy(t);
  const result = copy.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(copy.steps(), 'prettier\neslint\ntsc\n');
});

test('a failing lint step stops the check stage with its exit code before the type check', (t) => {
  const copy = launcherCopy(t, { eslint: 3 });
  assert.equal(copy.run(['check']).status, 3);
  assert.equal(copy.steps(), 'prettier\neslint\n');
});

for (const [stage, argv] of [
  ['full', []],
  ['fast', ['fast']],
] as [string, string[]][]) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`the ${stage} stage runs the format check, lint, the type check and the tests in that order and exits 0`, (t) => {
    const copy = launcherCopy(t);
    const result = copy.run(argv);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(copy.steps(), 'prettier\neslint\ntsc\ntests\n');
  });

  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`a failing format check stops the ${stage} stage with its exit code before lint, the type check and the tests`, (t) => {
    const copy = launcherCopy(t, { prettier: 4 });
    assert.equal(copy.run(argv).status, 4);
    assert.equal(copy.steps(), 'prettier\n');
  });

  test(`a failing lint step stops the ${stage} stage with its exit code before the type check and the tests`, (t) => {
    const copy = launcherCopy(t, { eslint: 3 });
    assert.equal(copy.run(argv).status, 3);
    assert.equal(copy.steps(), 'prettier\neslint\n');
  });

  test(`a failing type check stops the ${stage} stage with its exit code before the tests`, (t) => {
    const copy = launcherCopy(t, { tsc: 2 });
    assert.equal(copy.run(argv).status, 2);
    assert.equal(copy.steps(), 'prettier\neslint\ntsc\n');
  });

  test(`the ${stage} stage without node_modules says to run npm ci and runs nothing`, (t) => {
    const copy = launcherCopy(t, { installed: false });
    const result = copy.run(argv);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      // eslint-disable-next-line @stylistic/max-len -- the expected message stays whole, so grep finds it
      /node_modules\/prettier\/bin\/prettier\.cjs and node_modules\/eslint\/bin\/eslint\.js and node_modules\/typescript\/bin\/tsc not found: run npm ci first/,
    );
    assert.equal(copy.steps(), '');
  });
}
