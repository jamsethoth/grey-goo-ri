import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as processProbe from '../support/process-probe.ts';
import * as options from '../support/shell-case-options.ts';
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
  mkdirSync(join(root, 'lib'));
  copyFileSync(launcher, join(root, 'scripts', 'run-suite.ts'));
  for (const name of ['containment.ts', 'command-cleanup.ts'])
    copyFileSync(fileURLToPath(new URL(`../../lib/${name}`, import.meta.url)), join(root, 'lib', name));
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
  const run = (argv: string[], nodeFlags: string[] = []) =>
    spawnSync(process.execPath, [...nodeFlags, join(root, 'scripts', 'run-suite.ts'), ...argv], {
      encoding: 'utf8',
      env,
    });
  const steps = () => (existsSync(join(root, 'steps.log')) ? readFileSync(join(root, 'steps.log'), 'utf8') : '');
  return { root, run, steps };
}

// A copy whose one test leaves a detached process running, holding no pipe, so nothing but a census shows it: it writes
// the process's pid to leak.pid, and the process's command line carries a mark to find it by. Ended when the case ends,
// for a stage that left it running. A failing copy's test also fails.
function leakyCopy(t: TestContext, { fails = false } = {}) {
  // first in, first out: the process is ended while its pid file is still there
  let pidFile = '';
  t.after(() => processProbe.endProcessIn(pidFile));
  const copy = launcherCopy(t);
  pidFile = join(copy.root, 'leak.pid');
  writeFileSync(
    join(copy.root, 'test', 'unit', 'leak.test.mjs'),
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('leaves a process running', () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000) // sample-leftover'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync('leak.pid', String(child.pid));
  if (${fails}) throw new Error('fails on purpose');
});
`,
  );
  return { ...copy, pidFile };
}

// One process runs every test file, so a test calling process.exit(0) ends the whole stage with exit 0 and no report.
// What an earlier run left must not pass for this run's report (#285).
function endedEarly(t: TestContext) {
  const copy = launcherCopy(t);
  writeFileSync(join(copy.root, 'test', 'unit', 'early.test.mjs'), 'process.exit(0);\n');
  mkdirSync(join(copy.root, 'coverage'));
  writeFileSync(join(copy.root, 'coverage', 'lcov.info'), 'SF:lib/a.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n');
  const held = { lines: 100, functions: 100 };
  writeFileSync(join(copy.root, 'coverage-baseline.json'), JSON.stringify({ [process.platform]: held }));
  return copy;
}

test("a coverage stage whose test ends the process early fails, and does not read an earlier run's report", (t) => {
  const copy = endedEarly(t);
  const result = copy.run(['coverage']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /measured no lines/);
});

test('coverage update records nothing when a test ends the process early', (t) => {
  const copy = endedEarly(t);
  const before = readFileSync(join(copy.root, 'coverage-baseline.json'), 'utf8');
  const result = copy.run(['coverage', 'update']);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(readFileSync(join(copy.root, 'coverage-baseline.json'), 'utf8'), before);
});

test('a coverage stage that measures no lines fails', (t) => {
  const copy = launcherCopy(t);
  rmSync(join(copy.root, 'lib'), { recursive: true }); // nothing to measure
  const result = copy.run(['coverage']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /measured no lines/);
});

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

test('the check stage takes no census and says nothing of one', (t) => {
  const result = launcherCopy(t).run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /census/);
});

test('the process a census names is ended, and none is left after the stage', options.WIN_CASE, async (t) => {
  const copy = leakyCopy(t);
  assert.equal(copy.run(['fast']).status, 1);
  const pid = processProbe.pidIn(copy.pidFile);
  assert.ok(pid > 0, 'the sample case never started its process');
  await processProbe.waitFor(() => !processProbe.alive(pid), t.signal); // one left running fails at the case timeout
});

test(
  'a stage whose tests fail still names what they left running, and exits with their code',
  options.WIN_CASE,
  (t) => {
    const copy = leakyCopy(t, { fails: true });
    const result = copy.run(['fast']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /fails on purpose/);
    assert.match(result.stderr, /sample-leftover/);
  },
);

// Run with node:ffi off, so it says the same on every platform: off Windows there is no boundary at all.
test('a stage with no boundary says the census did not run, and passes on its tests alone', (t) => {
  const result = launcherCopy(t).run(['fast'], ['--no-experimental-ffi']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^census did not run: /m);
});

for (const [stage, argv] of [
  ['full', []],
  ['fast', ['fast']],
] as [string, string[]][]) {
  test(`the ${stage} stage fails when a case leaves a process running, and names it`, options.WIN_CASE, (t) => {
    const copy = leakyCopy(t);
    const result = copy.run(argv);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^ℹ fail 0$/m);
    assert.ok(
      result.stderr.includes(`pid ${processProbe.pidIn(copy.pidFile)}: `),
      `the leftover's pid is not named: ${result.stderr}`,
    );
    assert.match(result.stderr, /setTimeout\(\(\) => \{\}, 600000\) \/\/ sample-leftover/);
  });

  test(`the ${stage} stage that leaves nothing says its census found nothing`, options.WIN_CASE, (t) => {
    const result = launcherCopy(t).run(argv);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^census: no process left$/m);
  });

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
