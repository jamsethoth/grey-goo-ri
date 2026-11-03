import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { matchesGlob, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const launcherUrl = new URL('../../scripts/run-suite.mjs', import.meta.url);
// The machine's own cap, as the launcher computes it; the cases assert the rest of the command line literally.
const concurrency = `--test-concurrency=${Math.min(12, Math.max(1, availableParallelism() - 1))}`;
// ADR 0018: Prettier, ESLint and tsc run as node plus each package's own bin script, before the tests, in every stage.
const checks = [
  ['node_modules/prettier/bin/prettier.cjs', '--check', '.'],
  ['node_modules/eslint/bin/eslint.js', '.'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
];

test('the full stage runs node --test over the whole suite in the repo root, at most twelve files at once', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, []);
  assert.equal(cmd.command, process.execPath);
  assert.deepEqual(cmd.steps.at(-1), ['--test', concurrency]);
  assert.equal(resolve(cmd.cwd), resolve(root));
});

test('the full stage runs the format check, lint and the type check before the tests', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.suiteCommand({}, []).steps, [...checks, ['--test', concurrency]]);
});

test('the fast stage runs the format check, lint and the type check before the tests', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.suiteCommand({}, ['fast']).steps, [
    ...checks,
    ['--test', concurrency, 'test/unit/**/*.test.{mjs,ts}'],
  ]);
});

test('the fast stage runs only test/unit and the contract suites it is given', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, ['fast', 'sqlite', 'git']);
  assert.deepEqual(cmd.steps.at(-1), [
    '--test',
    concurrency,
    'test/unit/**/*.test.{mjs,ts}',
    'test/contract/sqlite/**/*.test.{mjs,ts}',
    'test/contract/git/**/*.test.{mjs,ts}',
  ]);
  assert.equal(resolve(cmd.cwd), resolve(root));
});

test('the fast stage with no boundary runs only test/unit', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.suiteCommand({}, ['fast']).steps.at(-1), [
    '--test',
    concurrency,
    'test/unit/**/*.test.{mjs,ts}',
  ]);
});

test('the check stage runs the format check, lint and the type check and no tests', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.suiteCommand({}, ['check']).steps, checks);
});

test('the check stage takes no boundary names', async () => {
  const runSuite = await import(launcherUrl);
  assert.throws(() => runSuite.suiteCommand({}, ['check', 'git']), {
    name: 'UsageError',
    message:
      /^usage: node scripts\/run-suite\.mjs \[fast \[boundary \.\.\.\]\]\n\s+node scripts\/run-suite\.mjs check\n/,
  });
});

test('the coverage stage runs test/unit with coverage of lib/ outside its process boundaries, and no checks', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, ['coverage']);
  assert.deepEqual(cmd.steps, [
    [
      '--test',
      concurrency,
      '--experimental-test-coverage',
      '--test-coverage-include-all',
      '--test-coverage-include=lib/**',
      '--test-coverage-exclude=lib/exec.mjs',
      '--test-coverage-exclude=lib/git.mjs',
      '--test-coverage-exclude=lib/containment.ts',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
      'test/unit/**/*.test.{mjs,ts}',
    ],
  ]);
  assert.equal(cmd.coverage, 'check');
});

test('coverage update runs the same tests and records a rise', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, ['coverage', 'update']);
  assert.deepEqual(cmd.steps, runSuite.suiteCommand({}, ['coverage']).steps);
  assert.equal(cmd.coverage, 'update');
});

test('coverage totals sum every file of an lcov report, floored to two places', async () => {
  const runSuite = await import(launcherUrl);
  const lcov = [
    'SF:lib/a.ts',
    'FNF:2',
    'FNH:2',
    'BRF:4',
    'BRH:1',
    'LH:2',
    'LF:3',
    'end_of_record',
    'SF:lib/b.mjs',
    'FNF:1',
    'FNH:0',
    'LH:0',
    'LF:3',
    'end_of_record',
    '',
  ].join('\r\n');
  assert.deepEqual(runSuite.coverageTotals(lcov), { lines: 33.33, functions: 66.66 });
});

test('coverage that falls below the recorded figures is reported as a fall', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.compareCoverage({ lines: 98.32, functions: 97.25 }, { lines: 98.31, functions: 97.25 }), {
    fell: ['lines 98.32 -> 98.31'],
    rose: [],
  });
});

test('coverage above the recorded figures is reported as a rise to record', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.compareCoverage({ lines: 98.32, functions: 97.25 }, { lines: 98.32, functions: 97.3 }), {
    fell: [],
    rose: ['functions 97.25 -> 97.3'],
  });
});

test('coverage equal to the recorded figures neither falls nor rises', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.compareCoverage({ lines: 98.32, functions: 97.25 }, { lines: 98.32, functions: 97.25 }), {
    fell: [],
    rose: [],
  });
});

test('a platform with no recorded figures has risen', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.compareCoverage(undefined, { lines: 98.32, functions: 97.25 }), {
    fell: [],
    rose: ['lines unrecorded -> 98.32', 'functions unrecorded -> 97.25'],
  });
});

test('every platform CI runs has recorded coverage figures', async () => {
  const baseline = JSON.parse(await readFile(new URL('../../coverage-baseline.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(baseline).sort(), ['linux', 'win32']);
});

// ADR 0016: anything outside the closed set stops the launcher before it runs anything.
const refused = [
  ['a node flag in place of the stage', ['--import=x']],
  ['a stage other than fast', ['full']],
  ['a flag after fast', ['fast', '--test-name-pattern=x']],
  ['a path after fast', ['fast', '../lib']],
  ['a glob after fast', ['fast', '*']],
  ['an unknown boundary', ['fast', 'nope']],
  ['a boundary in the wrong case', ['fast', 'GIT']],
  ['a file under test/contract that is not a directory', ['fast', 'git/git.test.mjs']],
  ['an argument after coverage other than update', ['coverage', 'git']],
  ['a flag after coverage update', ['coverage', 'update', '--test-name-pattern=x']],
];
for (const [what, argv] of refused) {
  test(`the launcher refuses ${what}`, async () => {
    const runSuite = await import(launcherUrl);
    assert.throws(() => runSuite.suiteCommand({}, argv), {
      name: 'UsageError',
      message: /^usage: node scripts\/run-suite\.mjs \[fast \[boundary \.\.\.\]\]/,
    });
  });
}

test('suiteCommand drops NODE_OPTIONS, NODE_PATH and npm_config_* and keeps the rest', async () => {
  const runSuite = await import(launcherUrl);
  const { env } = runSuite.suiteCommand(
    { NODE_OPTIONS: '--import=x', NODE_PATH: 'p', npm_config_node_options: '--import=x', KEEP: '1' },
    [],
  );
  assert.deepEqual(env, { KEEP: '1' });
});

test('the launcher is not a default node --test file', async () => {
  await readFile(launcherUrl);
  const patterns = [
    '**/*.test.{cjs,mjs,js}',
    '**/*-test.{cjs,mjs,js}',
    '**/*_test.{cjs,mjs,js}',
    '**/test-*.{cjs,mjs,js}',
    '**/test.{cjs,mjs,js}',
    '**/test/**/*.{cjs,mjs,js}',
  ];
  assert.deepEqual(
    patterns.filter((pattern) => matchesGlob('scripts/run-suite.mjs', pattern)),
    [],
  );
});

test('the codex rule allows only node scripts/run-suite.mjs and has no BOM', async () => {
  const bytes = await readFile(new URL('../../.codex/rules/test.rules', import.meta.url));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.equal(text.match(/prefix_rule\(/g)?.length, 1);
  assert.match(text, /pattern\s*=\s*\[\s*"node"\s*,\s*"scripts\/run-suite\.mjs"\s*\]/);
  assert.match(text, /decision\s*=\s*"allow"/);
});

test('npm test is the launcher', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-suite.mjs');
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^- test: `node scripts\/run-suite\.mjs`/m);
  assert.match(agents, /`scripts\/run-suite\.mjs` \|/, 'AGENTS.md lists scripts/run-suite.mjs in Layout');
});
