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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as stateDatabase from '../../lib/state-database.ts';
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
  assert.deepEqual(marked, ['plan', 'publish', 'trace', 'stats']);
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
  assert.equal(result.stderr.trim(), 'gg work list: not implemented');
});

test('gg work without a verb prints usage', () => {
  const result = gg('work', '1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^gg work: work takes a verb, one of list, resume, done, abandon, reset, approve\n/);
  assertUsage(result.stderr);
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

// A temp repo, a temp home and a temp GG_HOME, so gg reads no real user's gg.json; `user` becomes the user's gg.json
// when given.
function tempRepo(t: TestContext, user?: object) {
  const directory = tempDirectory.tempDirectory(t, 'gg-cli-');
  const repo = join(directory, 'repo');
  const home = join(directory, 'home');
  const userDirectory = join(directory, 'gg-home');
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (user) {
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(join(userDirectory, 'gg.json'), JSON.stringify(user));
  }
  const ggAt = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, GG_HOME: userDirectory },
    });
  const ggIn = (...args: string[]) => ggAt(repo, ...args);
  // gg from the temp directory beside the repository, which is in no repository.
  const ggOutside = (...args: string[]) => ggAt(directory, ...args);
  return { repo, userDirectory, ggIn, ggOutside };
}

// The machine settings gg init writes into the user's gg.json.
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// gg ships no Flow (P1a), so a repository that declares none is told to run gg init.
test('gg run in a repository without a Flow fails preflight naming gg init', (t) => {
  const { repo, ggIn } = tempRepo(t, MACHINE_SETTINGS);
  const result = ggIn('run', '1');
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(
      "error: flows: no Flow is declared; run gg init to write the example Flow into the repository's .agents/gg/ " +
        '[no-flow-declared]\n',
    ),
    result.stderr,
  );
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run fails preflight naming the unimplemented harness', (t) => {
  const { repo, ggIn } = tempRepo(t, MACHINE_SETTINGS);
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const result = ggIn('run', '1');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /harness claude: not implemented/);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

test('gg run without a harness fails admission naming the vertex and agent', (t) => {
  const { repo, ggIn } = tempRepo(t, MACHINE_SETTINGS);
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const file = join(repo, '.agents', 'gg', 'gg.json');
  const example = JSON.parse(readFileSync(file, 'utf8')) as { agents: unknown };
  example.agents = {
    implementer: { persona: 'implementer.md', access: 'workspace-write' },
    reviewer: { persona: 'reviewer.md', access: 'read-only' },
    senior: { persona: 'implementer.md', access: 'workspace-write' },
  };
  writeFileSync(file, JSON.stringify(example));
  const result = ggIn('run', '1');
  assert.equal(result.status, 2, result.stderr);
  assert.ok(
    result.stderr.includes(
      'error: agents.implementer: agent implementer names no harness; set one in the gg.json that declares it ' +
        '[harness-unset]\n',
    ),
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(
      'error: agents.reviewer: agent reviewer names no harness; set one in the gg.json that declares it ' +
        '[harness-unset]\n',
    ),
    result.stderr,
  );
  assert.ok(result.stderr.includes(fileURLToPath(new URL('../../examples/', import.meta.url))), result.stderr);
  assert.ok(result.stderr.includes('gg init --harness claude or codex'), result.stderr);
  assert.equal((result.stderr.match(/Set each Agent's harness/g) ?? []).length, 1);
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
});

// The flag reaches admission, which looks its value up among the declared Flows.
test('gg run accepts --flow with a value', (t) => {
  const { repo, ggIn } = tempRepo(t, MACHINE_SETTINGS);
  writeExampleLayer(join(repo, '.agents', 'gg'));
  const result = ggIn('run', '1', '--flow', 'light');
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(
      'error: flows: no Flow named light is declared; the declared Flows are default [unknown-flow]\n',
    ),
    result.stderr,
  );
  assert.equal(existsSync(join(repo, '.git', 'gg')), false, 'no gg directory under .git');
  const missing = ggIn('run', '1', '--flow');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /--flow/);
  assertUsage(missing.stderr);
});

// The example fixture as the repository's configuration in `directory`: its gg.json and every file it names.
function writeExampleLayer(directory: string) {
  mkdirSync(directory, { recursive: true });
  for (const name of exampleLayer.WRITTEN_NAMES) writeFileSync(join(directory, name), exampleLayer.fixtureText(name));
}

// --repo <path> names the repository in place of the current directory, for each command that acts on one (#321). Run
// from a directory in no repository, each fails without it and acts on the named repository with it.
const REPO_COMMANDS: [
  name: string,
  args: string[],
  acted: (result: ReturnType<typeof spawnSync>, repo: string) => void,
][] = [
  [
    'init',
    ['init'],
    (result, repo) => {
      assert.equal(result.status, 0, String(result.stderr));
      assert.deepEqual(readdirSync(join(repo, '.agents', 'gg')).sort(), [...exampleLayer.WRITTEN_NAMES].sort());
    },
  ],
  [
    'doctor',
    ['doctor'],
    (result) => {
      assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
      assert.ok(String(result.stdout).includes('\nvertex reviewer\n  procedure: review\n'), String(result.stdout));
    },
  ],
  [
    'run',
    ['run', '1'],
    (result) => {
      assert.equal(result.status, 1, String(result.stderr));
      assert.match(String(result.stderr), /harness claude: not implemented/);
    },
  ],
];
for (const [name, args, acted] of REPO_COMMANDS) {
  test(`gg ${name} --repo <path> acts on that repository from outside it`, (t) => {
    const { repo, ggOutside } = tempRepo(t, MACHINE_SETTINGS);
    if (name !== 'init') {
      writeExampleLayer(join(repo, '.agents', 'gg'));
      stateDatabase.create(join(repo, '.git'));
    }
    const without = ggOutside(...args);
    assert.notEqual(without.status, 0, 'outside any repository, gg has none to act on');
    acted(ggOutside(...args, '--repo', repo), repo);
    const missing = ggOutside(...args, '--repo');
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /--repo/);
    assertUsage(missing.stderr);
  });

  // Node reports a missing working directory as a missing executable, `spawn git ENOENT`, so gg names the path first.
  test(`gg ${name} --repo at a directory that does not exist names it`, (t) => {
    const { repo, ggOutside } = tempRepo(t, MACHINE_SETTINGS);
    const absent = join(repo, '..', 'absent');
    const result = ggOutside(...args, '--repo', absent);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, `gg ${name}: --repo ${resolve(absent)}: not a directory\n`);
  });

  // A file as the working directory fails the same way, `spawn git ENOENT`, so gg names it too.
  test(`gg ${name} --repo at an existing file names it`, (t) => {
    const { repo, ggOutside } = tempRepo(t, MACHINE_SETTINGS);
    const file = join(repo, 'a-file');
    writeFileSync(file, '');
    const result = ggOutside(...args, '--repo', file);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, `gg ${name}: --repo ${resolve(file)}: not a directory\n`);
  });
}

test('gg init writes the example at the repository root, and a second gg init keeps it', (t) => {
  const { repo, ggIn } = tempRepo(t);
  const first = ggIn('init');
  assert.equal(first.status, 0, first.stderr);
  const layer = join(repo, '.agents', 'gg');
  assert.deepEqual(readdirSync(layer).sort(), [...exampleLayer.WRITTEN_NAMES].sort());
  const second = ggIn('init');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^gg init kept the existing configuration and wrote none of the example: /);
});

// gg.db lives in the git common dir and is not committed, so gg init runs once per clone (#150).
test('gg init creates the State Database in the git common dir, and a second gg init keeps it', (t) => {
  const { repo, ggIn } = tempRepo(t);
  const database = join(repo, '.git', 'gg', 'gg.db');
  const first = ggIn('init');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.includes(`\ngg init created the State Database at ${database}.\n`), first.stdout);
  const second = ggIn('init');
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.includes(`\ngg init kept the State Database at ${database}.\n`), second.stdout);
});

// The first thing a person runs: gg init writes both sources, and gg doctor then needs only the test command.
test('gg init --harness claude then gg doctor passes in a temp repository with a temp GG_HOME', (t) => {
  const { repo, userDirectory, ggIn } = tempRepo(t);
  const init = ggIn('init', '--harness', 'claude');
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(join(userDirectory, 'gg.json')), "gg init creates the user's gg.json in GG_HOME");
  const file = join(repo, '.agents', 'gg', 'gg.json');
  const written = JSON.parse(readFileSync(file, 'utf8')) as { baseBranch: string; commands: Record<string, string> };
  assert.equal(written.baseBranch, 'main', "the repository's default branch");
  written.commands.test = 'npm test';
  writeFileSync(file, JSON.stringify(written));
  const doctor = ggIn('doctor');
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /\n0 errors, 2 warnings\n$/);
});

test("gg doctor reads the repository's configuration and its schemas and prints the Resolved Flow", (t) => {
  const { repo, ggIn } = tempRepo(t, MACHINE_SETTINGS);
  writeExampleLayer(join(repo, '.agents', 'gg'));
  stateDatabase.create(join(repo, '.git'));
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
  test(`gg ${args[0]} names a malformed gg.json without a stack trace`, (t) => {
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
