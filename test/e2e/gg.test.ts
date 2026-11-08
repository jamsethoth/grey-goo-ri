import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exampleLayer from '../support/example-layer.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bin = fileURLToPath(new URL('../../bin/gg.ts', import.meta.url));
const commands = ['init', 'doctor', 'plan', 'publish', 'run', 'work', 'trace', 'stats'];

function gg(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function assertUsage(text: string) {
  for (const name of commands) assert.match(text, new RegExp(`\\b${name}\\b`), `usage lists ${name}`);
  for (const verb of ['list', 'resume', 'abandon', 'reset', 'approve'])
    assert.match(text, new RegExp(`\\b${verb}\\b`), `usage lists work ${verb}`);
}

test('gg with no arguments prints usage and exits 0', () => {
  const result = gg();
  assert.equal(result.status, 0, result.stderr);
  assertUsage(result.stdout);
});

test('gg --help prints usage and exits 0', () => {
  const result = gg('--help');
  assert.equal(result.status, 0, result.stderr);
  assertUsage(result.stdout);
  assert.equal(result.stdout, gg().stdout);
});

test('usage marks each unimplemented command', () => {
  const commandLines = gg('--help')
    .stdout.split('\n')
    .filter((line) => line.startsWith('  '));
  const marked = commandLines
    .filter((line) => line.endsWith(' (not implemented)'))
    .map((line) => line.trim().split(' ')[0]);
  assert.deepEqual(marked, ['plan', 'publish', 'work', 'trace', 'stats']);
  assert.match(gg('--help').stdout, /^ {2}doctor {4}validate the configuration and print each Resolved Flow$/m);
});

test('gg with an unknown command prints usage to stderr and exits 1', () => {
  const result = gg('bogus');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gg: unknown command bogus/);
  assertUsage(result.stderr);
});

for (const [name, message] of [
  ['plan', 'gg plan: not implemented'],
  ['publish', 'gg publish: not implemented'],
  ['work', 'gg work: not implemented'],
  ['trace', 'gg trace: not implemented'],
  ['stats', 'gg stats: not implemented'],
]) {
  test(`gg ${name} exits 1 with a not-implemented message`, () => {
    const result = gg(name, '1');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr.trim(), message);
  });
}

test('gg work list exits 1 with a not-implemented message', () => {
  const result = gg('work', 'list');
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'gg work: not implemented');
});

test('gg run rejects an unknown option with a usage error', () => {
  const result = gg('run', '--bogus', '1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --bogus/);
  assertUsage(result.stderr);
  assert.doesNotMatch(result.stderr, /gg run: not implemented/);
});

for (const [name, flag, error] of [
  ['run', '--bg', /unknown option --bg/],
  ['run', '--trust', /unknown option --trust/],
  ['init', '--json', /unknown option --json/],
] as [string, string, RegExp][]) {
  test(`gg ${name} rejects the legacy boolean flag ${flag}`, () => {
    const result = gg(name, flag, '1');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assertUsage(result.stderr);
  });
}

// A temp repo and a temp home, so gg reads no real user Layer; `layer` becomes the user Layer when given.
function tempRepo(t: TestContext, layer?: string) {
  const directory = tempDirectory.tempDirectory(t, 'gg-cli-');
  const repo = join(directory, 'repo');
  const home = join(directory, 'home');
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (layer) {
    mkdirSync(join(home, '.agents', 'gg'), { recursive: true });
    writeFileSync(join(home, '.agents', 'gg', 'gg.json'), layer);
  }
  const ggIn = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  return { repo, ggIn };
}

// gg ships no Flow (P1a), so a repository that declares none is told to run gg init.
test('gg run in a repository without a Flow fails preflight naming gg init', (t) => {
  const { repo, ggIn } = tempRepo(t);
  const result = ggIn('run', '1');
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(
      'error: flows: no Flow is declared; run gg init to write the example Flow into the repository Layer ' +
        '[no-flow-declared]\n',
    ),
    result.stderr,
  );
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run fails preflight naming the unimplemented harness', (t) => {
  const { repo, ggIn } = tempRepo(t, readFileSync(new URL('../../examples/claude.json', import.meta.url), 'utf8'));
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const result = ggIn('run', '1');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /harness claude: not implemented/);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run without a harness fails admission naming the vertex and agent', (t) => {
  const { repo, ggIn } = tempRepo(t);
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const result = ggIn('run', '1');
  assert.equal(result.status, 2, result.stderr);
  assert.ok(
    result.stderr.includes(
      'error: agents.implementer: agent implementer names no harness; set one in a user or repository Layer ' +
        '[harness-unset]\n',
    ),
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(
      'error: agents.reviewer: agent reviewer names no harness; set one in a user or repository Layer ' +
        '[harness-unset]\n',
    ),
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(fileURLToPath(new URL('../../examples/claude.json', import.meta.url))),
    result.stderr,
  );
  assert.ok(result.stderr.includes('into the user Layer at '), result.stderr);
  assert.equal((result.stderr.match(/Merge /g) ?? []).length, 1);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

// The example fixture as a repository Layer at `layer`: its gg.json and every file it names.
function writeExampleLayer(layer: string) {
  mkdirSync(layer, { recursive: true });
  for (const name of exampleLayer.WRITTEN_NAMES) writeFileSync(join(layer, name), exampleLayer.fixtureText(name));
}

test('gg init writes the example Layer at the repository root, and a second gg init keeps it', (t) => {
  const { repo, ggIn } = tempRepo(t);
  const first = ggIn('init');
  assert.equal(first.status, 0, first.stderr);
  const layer = join(repo, '.agents', 'gg');
  assert.deepEqual(readdirSync(layer).sort(), [...exampleLayer.WRITTEN_NAMES].sort());
  const second = ggIn('init');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^gg init kept the existing Layer and wrote nothing: /);
});

test('gg doctor reads the repository Layer and its schemas and prints the Resolved Flow', (t) => {
  const agents = { implementer: { harness: 'claude' }, reviewer: { harness: 'claude' }, senior: { harness: 'claude' } };
  const { repo, ggIn } = tempRepo(t, JSON.stringify({ agents }));
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const result = ggIn('doctor');
  assert.ok(
    result.stdout.includes('\nvertex reviewer\n  procedure: review\n  agent: reviewer (harness claude)\n'),
    result.stdout + result.stderr,
  );
  assert.ok(result.stdout.includes('\n  routes: misscoped -> end needs-replan, * -> end needs-human\n'), result.stdout);
  assert.ok(!result.stdout.includes('\nerror: '), result.stdout);
  assert.equal(result.status, 0, result.stdout);
});

for (const args of [['doctor'], ['run', '1']]) {
  test(`gg ${args[0]} names a malformed Layer file without a stack trace`, (t) => {
    const { repo, ggIn } = tempRepo(t);
    const file = join(repo, '.agents', 'gg', 'gg.json');
    mkdirSync(join(repo, '.agents', 'gg'), { recursive: true });
    writeFileSync(file, '{\n  "testPaths": [\n    "test/**",\n  ]\n}\n');
    const result = ggIn(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `gg ${args[0]}: ${file}:4:3: invalid JSON, value expected\n`);
  });
}

test('gg run rejects a ticket that is not a positive integer', (t) => {
  const { ggIn } = tempRepo(t);
  const result = ggIn('run', 'abc');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a positive integer, got "abc"/);
});

test('gg stats requires a value for --label', () => {
  const result = gg('stats', '--label');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--label needs a value/);
  assertUsage(result.stderr);
});

test('gg stats with valid options reaches the not-implemented stub', () => {
  const result = gg('stats', '--json', '--label', 'x');
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'gg stats: not implemented');
});

test('gg plan --finish without an id prints usage', () => {
  const result = gg('plan', '--finish');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^gg plan: --finish needs a value\n/);
  assertUsage(result.stderr);
  assert.match(result.stderr, /plan --finish <planId>/);
});

test('gg plan rejects a value on a boolean flag', () => {
  const result = gg('plan', '--bg=yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--bg does not take a value/);
  assertUsage(result.stderr);
});

// Removes the link itself: a recursive remove on its path could walk into the repository it points at.
function removeLink(link: string) {
  if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
}

// The layout npm link and npm install -g <checkout> make: node_modules/grey-goo-ri links to the checkout.
function linkedInstall(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'gg-linked-'));
  const link = join(directory, 'node_modules', 'grey-goo-ri');
  t.after(() => {
    removeLink(link);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'node_modules'));
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

test('gg runs through a linked install, as npm link and npm install -g <checkout> lay it out', (t) => {
  const link = linkedInstall(t);
  const result = spawnSync(process.execPath, [join(link, 'bin', 'gg.ts'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertUsage(result.stdout);
  removeLink(link);
  assert.equal(existsSync(link), false);
  for (const file of ['package.json', 'bin/gg.ts', 'lib/paths.ts']) assert.ok(existsSync(join(root, file)), file);
});

test('a copy of gg under node_modules cannot start, which is why the install is linked', (t) => {
  const link = linkedInstall(t);
  // Keeping the link path makes Node see every file under node_modules, as it would in a copy.
  const result = spawnSync(
    process.execPath,
    ['--preserve-symlinks', '--preserve-symlinks-main', join(link, 'bin', 'gg.ts'), '--help'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});
