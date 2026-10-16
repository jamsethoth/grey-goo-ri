import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { matchesGlob, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcherUrl = new URL('../scripts/run-suite.mjs', import.meta.url);

test('suiteCommand ignores arguments and runs node --test in the repo root', async () => {
  const runSuite = await import(launcherUrl);
  const argv = process.argv;
  const cwd = process.cwd();
  process.argv = [process.execPath, fileURLToPath(launcherUrl), '--import=x', '--test-name-pattern=nothing'];
  process.chdir(tmpdir());
  try {
    const cmd = runSuite.suiteCommand({});
    assert.equal(cmd.command, process.execPath);
    assert.deepEqual(cmd.args, ['--test']);
    assert.equal(resolve(cmd.cwd), resolve(root));
  } finally {
    process.argv = argv;
    process.chdir(cwd);
  }
});

test('suiteCommand drops NODE_OPTIONS, NODE_PATH and npm_config_* and keeps the rest', async () => {
  const runSuite = await import(launcherUrl);
  const { env } = runSuite.suiteCommand({ NODE_OPTIONS: '--import=x', NODE_PATH: 'p', npm_config_node_options: '--import=x', KEEP: '1' });
  assert.equal(env.KEEP, '1');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'npm_config_node_options']) assert.ok(!(key in env), `${key} removed`);
});

test('the launcher is not a default node --test file', async () => {
  await readFile(launcherUrl);
  const patterns = ['**/*.test.{cjs,mjs,js}', '**/*-test.{cjs,mjs,js}', '**/*_test.{cjs,mjs,js}', '**/test-*.{cjs,mjs,js}', '**/test.{cjs,mjs,js}', '**/test/**/*.{cjs,mjs,js}'];
  for (const pattern of patterns) assert.equal(matchesGlob('scripts/run-suite.mjs', pattern), false, pattern);
});

test('the codex rule allows only node scripts/run-suite.mjs and has no BOM', async () => {
  const bytes = await readFile(new URL('../.codex/rules/test.rules', import.meta.url));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.equal(text.match(/prefix_rule\(/g)?.length, 1);
  assert.match(text, /pattern\s*=\s*\[\s*"node"\s*,\s*"scripts\/run-suite\.mjs"\s*\]/);
  assert.match(text, /decision\s*=\s*"allow"/);
});

test('npm test is the launcher', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-suite.mjs');
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^- test: `node scripts\/run-suite\.mjs`/m);
  assert.ok(agents.includes('`scripts/run-suite.mjs`'), 'AGENTS.md lists scripts/run-suite.mjs in Layout');
});
