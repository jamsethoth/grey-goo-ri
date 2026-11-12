import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { matchesGlob, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runSuite from '../../scripts/run-suite.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const launcherUrl = new URL('../../scripts/run-suite.ts', import.meta.url);
// The machine's own cap, as the launcher computes it; the cases assert the rest of the command line literally.
const concurrency = `--test-concurrency=${Math.min(12, Math.max(1, availableParallelism() - 1))}`;
// ADR 0018: Prettier, ESLint and tsc run as node plus each package's own bin script, before the tests, in every stage.
const checks = [
  ['node_modules/prettier/bin/prettier.cjs', '--check', '.'],
  ['node_modules/eslint/bin/eslint.js', '.'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
];

test('the full stage runs node --test over the whole suite in the repo root, at most twelve files at once', () => {
  const suite = runSuite.suiteCommand({}, []);
  assert.equal(suite.command, process.execPath);
  assert.deepEqual(suite.steps.at(-1), ['--test', concurrency]);
  assert.equal(resolve(suite.cwd), resolve(root));
});

test('the full stage runs the format check, lint and the type check before the tests', () => {
  assert.deepEqual(runSuite.suiteCommand({}, []).steps, [...checks, ['--test', concurrency]]);
});

test('the fast stage runs the format check, lint and the type check before the tests', () => {
  assert.deepEqual(runSuite.suiteCommand({}, ['fast']).steps, [
    ...checks,
    ['--test', concurrency, 'test/unit/**/*.test.{mjs,ts}'],
  ]);
});

test('the fast stage runs only test/unit and the contract suites it is given', () => {
  const suite = runSuite.suiteCommand({}, ['fast', 'sqlite', 'git']);
  assert.deepEqual(suite.steps.at(-1), [
    '--test',
    concurrency,
    'test/unit/**/*.test.{mjs,ts}',
    'test/contract/sqlite/**/*.test.{mjs,ts}',
    'test/contract/git/**/*.test.{mjs,ts}',
  ]);
  assert.equal(resolve(suite.cwd), resolve(root));
});

test('the fast stage with no boundary runs only test/unit', () => {
  assert.deepEqual(runSuite.suiteCommand({}, ['fast']).steps.at(-1), [
    '--test',
    concurrency,
    'test/unit/**/*.test.{mjs,ts}',
  ]);
});

test('the check stage runs the format check, lint and the type check and no tests', () => {
  assert.deepEqual(runSuite.suiteCommand({}, ['check']).steps, checks);
});

test('the full stage takes a census', () => {
  assert.equal(runSuite.suiteCommand({}, []).census, true);
});

test('the fast stage takes a census', () => {
  assert.equal(runSuite.suiteCommand({}, ['fast']).census, true);
});

test('the check stage takes no census: it runs no tests', () => {
  assert.equal(runSuite.suiteCommand({}, ['check']).census, undefined);
});

// test/unit/ may not reach process boundaries, and a forced exit could lose the one process's report (#290).
test('the coverage stage takes no census', () => {
  assert.equal(runSuite.suiteCommand({}, ['coverage']).census, undefined);
});

// ADR 0016, amended: a unit test imports the launcher, so what it loads of lib/ is loaded on demand.
test('the launcher loads from lib/ only the job calls and their one import, and only on demand', async () => {
  const source = await readFile(launcherUrl, 'utf8');
  const loaded = [...source.matchAll(/import\('\.\.\/lib\/([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(loaded.sort(), ['command-cleanup.ts', 'containment.ts']);
  assert.doesNotMatch(source, /^import (?!type )[^;]*\.\.\/lib\//m);
});

test('the check stage takes no boundary names', () => {
  assert.throws(() => runSuite.suiteCommand({}, ['check', 'git']), {
    name: 'SuiteUsageError',
    message: /^usage: node scripts\/run-suite\.ts \[fast \[boundary \.\.\.\]\]\n\s+node scripts\/run-suite\.ts check\n/,
  });
});

test('the coverage stage runs test/unit in one process over lib/ outside its boundaries, with no checks', () => {
  const suite = runSuite.suiteCommand({}, ['coverage']);
  assert.deepEqual(suite.steps, [
    [
      '--test',
      '--test-isolation=none',
      '--experimental-test-coverage',
      '--test-coverage-include-all',
      '--test-coverage-include=lib/**',
      '--test-coverage-exclude=lib/exec.ts',
      '--test-coverage-exclude=lib/git.ts',
      '--test-coverage-exclude=lib/git-temp-index.ts',
      '--test-coverage-exclude=lib/git-default-branch.ts',
      '--test-coverage-exclude=lib/process-tree.ts',
      '--test-coverage-exclude=lib/containment.ts',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
      'test/unit/**/*.test.{mjs,ts}',
    ],
  ]);
  assert.equal(suite.coverage, true);
});

test('coverage totals sum every file of an lcov report, floored to two places', () => {
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

test('coverage below the floor is reported, figure by figure', () => {
  assert.deepEqual(runSuite.belowFloor({ lines: 98.99, functions: 98.5 }, { lines: 99, functions: 98.5 }), [
    'lines 98.99 < 99',
  ]);
});

test('coverage at or above the floor holds', () => {
  assert.deepEqual(runSuite.belowFloor({ lines: 99, functions: 99.2 }, { lines: 99, functions: 98.5 }), []);
});

// ADR 0016: anything outside the closed set stops the launcher before it runs anything.
const refused: [string, string[]][] = [
  ['a node flag in place of the stage', ['--import=x']],
  ['a stage other than fast', ['full']],
  ['a flag after fast', ['fast', '--test-name-pattern=x']],
  ['a path after fast', ['fast', '../lib']],
  ['a glob after fast', ['fast', '*']],
  ['an unknown boundary', ['fast', 'nope']],
  ['a boundary in the wrong case', ['fast', 'GIT']],
  ['a file under test/contract that is not a directory', ['fast', 'git/git.test.mjs']],
  ['an argument after coverage', ['coverage', 'update']],
  ['a flag after coverage', ['coverage', '--test-name-pattern=x']],
];
for (const [what, argv] of refused) {
  test(`the launcher refuses ${what}`, () => {
    assert.throws(() => runSuite.suiteCommand({}, argv), {
      name: 'SuiteUsageError',
      message: /^usage: node scripts\/run-suite\.ts \[fast \[boundary \.\.\.\]\]/,
    });
  });
}

test('suiteCommand drops NODE_OPTIONS, NODE_PATH and npm_config_* and keeps the rest', () => {
  const { env } = runSuite.suiteCommand(
    { NODE_OPTIONS: '--import=x', NODE_PATH: 'p', npm_config_node_options: '--import=x', KEEP: '1' },
    [],
  );
  assert.deepEqual(env, { KEEP: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
});

test("suiteCommand gives git an empty global config and no system config, in place of the caller's", () => {
  const { env } = runSuite.suiteCommand({ git_config_global: 'C:/Users/dev/.gitconfig', Git_Config_NoSystem: '0' }, []);
  assert.deepEqual(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
});

test('the launcher is not a default node --test file', async () => {
  await readFile(launcherUrl);
  const patterns = [
    '**/*.test.{cjs,mjs,js,cts,mts,ts}',
    '**/*-test.{cjs,mjs,js,cts,mts,ts}',
    '**/*_test.{cjs,mjs,js,cts,mts,ts}',
    '**/test-*.{cjs,mjs,js,cts,mts,ts}',
    '**/test.{cjs,mjs,js,cts,mts,ts}',
    '**/test/**/*.{cjs,mjs,js,cts,mts,ts}',
  ];
  assert.deepEqual(
    patterns.filter((pattern) => matchesGlob('scripts/run-suite.ts', pattern)),
    [],
  );
});

test('the codex rule allows only node scripts/run-suite.ts and has no BOM', async () => {
  const bytes = await readFile(new URL('../../.codex/rules/test.rules', import.meta.url));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.equal(text.match(/prefix_rule\(/g)?.length, 1);
  assert.match(text, /pattern\s*=\s*\[\s*"node"\s*,\s*"scripts\/run-suite\.ts"\s*\]/);
  assert.match(text, /decision\s*=\s*"allow"/);
});

test('npm test is the launcher', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.test, 'node scripts/run-suite.ts');
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^- test: `node scripts\/run-suite\.ts`/m);
  assert.match(agents, /`scripts\/run-suite\.ts` \|/, 'AGENTS.md lists scripts/run-suite.ts in Layout');
});
