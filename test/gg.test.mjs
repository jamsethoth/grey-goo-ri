import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/gg.mjs', import.meta.url));
const commands = ['init', 'doctor', 'plan', 'publish', 'run', 'work', 'trace', 'stats'];

function gg(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function assertUsage(text) {
  for (const name of commands) assert.match(text, new RegExp(`\\b${name}\\b`), `usage lists ${name}`);
  for (const verb of ['list', 'resume', 'abandon', 'reset', 'approve']) assert.match(text, new RegExp(`\\b${verb}\\b`), `usage lists work ${verb}`);
}

test('gg with no arguments prints usage and exits 0', () => {
  const r = gg();
  assert.equal(r.status, 0, r.stderr);
  assertUsage(r.stdout);
});

test('gg --help prints usage and exits 0', () => {
  const r = gg('--help');
  assert.equal(r.status, 0, r.stderr);
  assertUsage(r.stdout);
  assert.equal(r.stdout, gg().stdout);
});

test('gg with an unknown command prints usage to stderr and exits 1', () => {
  const r = gg('bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gg: unknown command bogus/);
  assertUsage(r.stderr);
});

test('every listed command exits 1 with a not-implemented message', () => {
  for (const name of commands.filter((c) => c !== 'run')) {
    const r = gg(name, '1');
    assert.equal(r.status, 1, `${name} exit code`);
    assert.equal(r.stderr.trim(), `gg ${name}: not implemented`);
  }
  const r = gg('work', 'list');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'gg work: not implemented');
});

test('gg run rejects an unknown option with a usage error', () => {
  const r = gg('run', '--bogus', '1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --bogus/);
  assertUsage(r.stderr);
  assert.doesNotMatch(r.stderr, /not implemented/);
});

test('commands without boolean flags reject the legacy boolean flags', () => {
  for (const [name, flag] of [['run', '--bg'], ['run', '--trust'], ['init', '--json']]) {
    const r = gg(name, flag, '1');
    assert.equal(r.status, 1, `${name} ${flag} exit code`);
    assert.match(r.stderr, new RegExp(`unknown option ${flag}`), `${name} ${flag}`);
    assertUsage(r.stderr);
  }
});

// A temp repo and a temp home, so gg reads no real user Layer; `layer` becomes the user Layer when given.
function tempRepo(t, layer) {
  const root = mkdtempSync(join(tmpdir(), 'gg-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (layer) {
    mkdirSync(join(home, '.agents', 'gg'), { recursive: true });
    writeFileSync(join(home, '.agents', 'gg', 'gg.json'), layer);
  }
  const ggIn = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { repo, ggIn };
}

test('gg run fails preflight naming the unimplemented harness', (t) => {
  const { repo, ggIn } = tempRepo(t, readFileSync(new URL('../examples/claude.json', import.meta.url), 'utf8'));
  const r = ggIn('run', '1');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /harness claude: not implemented/);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run without a harness fails admission naming the vertex and node', (t) => {
  const { repo, ggIn } = tempRepo(t);
  const r = ggIn('run', '1');
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes('no harness configured for node implementer; copy '), r.stderr);
  assert.ok(r.stderr.includes(fileURLToPath(new URL('../examples/claude.json', import.meta.url))), r.stderr);
  assert.ok(r.stderr.includes('to the user Layer at '), r.stderr);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run rejects a ticket that is not a positive integer', (t) => {
  const { ggIn } = tempRepo(t);
  const r = ggIn('run', 'abc');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a positive integer, got "abc"/);
});

test('gg stats requires a value for --label', () => {
  const r = gg('stats', '--label');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--label needs a value/);
  assertUsage(r.stderr);
});

test('gg stats with valid options reaches the not-implemented stub', () => {
  const r = gg('stats', '--json', '--label', 'x');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'gg stats: not implemented');
});

test('gg plan --finish without an id prints usage', () => {
  const r = gg('plan', '--finish');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^gg plan: --finish needs a value\n/);
  assertUsage(r.stderr);
  assert.match(r.stderr, /plan --finish <planId>/);
});

test('gg plan rejects a value on a boolean flag', () => {
  const r = gg('plan', '--bg=yes');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--bg does not take a value/);
  assertUsage(r.stderr);
});
