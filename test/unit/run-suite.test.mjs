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

test('the full stage runs node --test over the whole suite in the repo root, at most twelve files at once', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, []);
  assert.equal(cmd.command, process.execPath);
  assert.deepEqual(cmd.args, ['--test', concurrency]);
  assert.equal(resolve(cmd.cwd), resolve(root));
});

test('the fast stage runs only test/unit and the contract suites it is given', async () => {
  const runSuite = await import(launcherUrl);
  const cmd = runSuite.suiteCommand({}, ['fast', 'sqlite', 'git']);
  assert.deepEqual(cmd.args, ['--test', concurrency, 'test/unit/**/*.test.mjs', 'test/contract/sqlite/**/*.test.mjs', 'test/contract/git/**/*.test.mjs']);
  assert.equal(resolve(cmd.cwd), resolve(root));
});

test('the fast stage with no boundary runs only test/unit', async () => {
  const runSuite = await import(launcherUrl);
  assert.deepEqual(runSuite.suiteCommand({}, ['fast']).args, ['--test', concurrency, 'test/unit/**/*.test.mjs']);
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
];
for (const [what, argv] of refused) {
  test(`the launcher refuses ${what}`, async () => {
    const runSuite = await import(launcherUrl);
    assert.throws(() => runSuite.suiteCommand({}, argv), { name: 'UsageError', message: /^usage: node scripts\/run-suite\.mjs \[fast \[boundary \.\.\.\]\]/ });
  });
}

test('suiteCommand drops NODE_OPTIONS, NODE_PATH and npm_config_* and keeps the rest', async () => {
  const runSuite = await import(launcherUrl);
  const { env } = runSuite.suiteCommand({ NODE_OPTIONS: '--import=x', NODE_PATH: 'p', npm_config_node_options: '--import=x', KEEP: '1' }, []);
  assert.deepEqual(env, { KEEP: '1' });
});

test('the launcher is not a default node --test file', async () => {
  await readFile(launcherUrl);
  const patterns = ['**/*.test.{cjs,mjs,js}', '**/*-test.{cjs,mjs,js}', '**/*_test.{cjs,mjs,js}', '**/test-*.{cjs,mjs,js}', '**/test.{cjs,mjs,js}', '**/test/**/*.{cjs,mjs,js}'];
  assert.deepEqual(patterns.filter((pattern) => matchesGlob('scripts/run-suite.mjs', pattern)), []);
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
