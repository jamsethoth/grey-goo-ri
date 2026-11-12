import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as record from '../../lib/record.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// gg doctor reads no labels in these cases: the example asks nobody.
const GH = github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh);

// A repository, its common dir and a user directory for `gg init`, none holding a gg.json or a State Database yet.
function initRoots(t: TestContext) {
  const directory = tempDirectory.tempDirectory(t, 'gg-init-', (root) => join(root, 'repo', '.git'));
  return { repo: join(directory, 'repo'), user: join(directory, 'user'), commonDir: join(directory, 'repo', '.git') };
}
const repositoryDirectory = (root: string) => join(root, '.agents', 'gg');
const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');
const knownRecord = (commonDir: string) =>
  record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 7,
    epic: null,
    flow: { name: 'default', entry: 'red' },
    configHash: 'x',
    run: '20261016T000000Z-seed00',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/7-add',
    base: 'main',
  });
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// gg doctor over a repository and user directory as gg reads them, with the Harnesses gg ships.
async function doctorOver(repo: string, user: string, commonDir?: string) {
  return doctor.doctor({
    config: config.loadSources(repo, user),
    harnesses: shipped.HARNESSES,
    gh: GH,
    cwd: repo,
    commonDir,
  });
}

// Adds the test command the example leaves out, which only the repository can say.
function declareTest(repo: string) {
  const file = join(repositoryDirectory(repo), 'gg.json');
  const written = JSON.parse(readFileSync(file, 'utf8')) as { commands: Record<string, string> };
  written.commands.test = 'npm test';
  writeFileSync(file, JSON.stringify(written));
}

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("gg init writes the example with the repository's keys, creates the user's gg.json, and gg doctor accepts both", async (t) => {
  const { repo, user, commonDir } = initRoots(t);
  const text = doctor.init(repo, { baseBranch: 'trunk', userDirectory: user, commonDir });
  const written = repositoryDirectory(repo);
  assert.deepEqual(readdirSync(written).sort(), [...exampleLayer.WRITTEN_NAMES].sort(), 'every file but doctor.txt');
  for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
    assert.equal(readFileSync(join(written, name), 'utf8'), exampleLayer.fixtureText(name), name);
  const expected = JSON.parse(exampleLayer.fixtureText('gg.json')) as {
    commands: Record<string, string>;
    baseBranch: string;
  };
  delete expected.commands.test;
  expected.baseBranch = 'trunk';
  assert.deepEqual(
    JSON.parse(readFileSync(join(written, 'gg.json'), 'utf8')),
    expected,
    "the fixture's gg.json with commands.test removed and the repository's default branch",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(user, 'gg.json'), 'utf8')), MACHINE_SETTINGS);
  // The advice gg init gives the person who runs it (L9, J11).
  assert.match(text, /read-only default workflow permissions/);
  assert.match(text, /assumes the test command is deterministic/);
  // Only gg init creates the State Database (#150).
  assert.ok(text.includes(`\ngg init created the State Database at ${dbPath(commonDir)}.\n`), text);
  assert.deepEqual(record.loadAll(commonDir, 'ticket'), [], 'the State Database opens');

  declareTest(repo);
  const accepted = await doctorOver(repo, user, commonDir);
  assert.equal(accepted.exitCode, 0, accepted.text);
  assert.match(accepted.text, /\n0 errors, 2 warnings\n$/);
});

test('gg init keeps an existing user gg.json', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  mkdirSync(user, { recursive: true });
  const kept = '{ "maxParallel": 5, "worktreeRoot": "D:/wt" }\n';
  writeFileSync(join(user, 'gg.json'), kept);
  doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir });
  assert.equal(readFileSync(join(user, 'gg.json'), 'utf8'), kept);
});

// Each Agent of the example, its Persona and access, with the harness, model and effort examples/<harness>.json names.
const HARNESS_AGENTS = {
  claude: {
    implementer: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'claude',
      model: 'opus',
      effort: 'high',
    },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'claude', model: 'sonnet', effort: 'high' },
    senior: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude', model: 'opus', effort: 'max' },
  },
  codex: {
    implementer: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
    },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    senior: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    },
  },
};

for (const [harness, expected] of Object.entries(HARNESS_AGENTS)) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`gg init --harness ${harness} writes each Agent's harness, model and effort, and gg doctor accepts them`, async (t) => {
    const { repo, user, commonDir } = initRoots(t);
    doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir, harness });
    const { agents } = JSON.parse(readFileSync(join(repositoryDirectory(repo), 'gg.json'), 'utf8')) as {
      agents: unknown;
    };
    assert.deepEqual(agents, expected);
    declareTest(repo);
    const accepted = await doctorOver(repo, user, commonDir);
    assert.equal(accepted.exitCode, 0, accepted.text);
  });
}

// --harness takes a name, never a path, and writes nothing when it names no Harness examples/ holds.
test('gg init --harness with a name examples/ does not hold fails, writing nothing', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  assert.throws(
    () => doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir, harness: '../package' }),
    {
      message: 'no Harness named ../package has example settings; gg init --harness takes claude or codex',
    },
  );
  assert.equal(existsSync(repo), false, 'no repository file');
  assert.equal(existsSync(user), false, "no user's gg.json");
});

test('gg init keeps an existing repository configuration, says so and exits successfully', (t) => {
  // It returns what it says, and throws only on a failed write, so gg exits 0 (test/e2e/gg.test.ts).
  const { repo, user, commonDir } = initRoots(t);
  mkdirSync(repositoryDirectory(repo), { recursive: true });
  const file = join(repositoryDirectory(repo), 'gg.json');
  const kept = '{ "commands": { "test": "make test" } }\n';
  writeFileSync(file, kept);
  assert.ok(
    doctor
      .init(repo, { baseBranch: 'main', userDirectory: user, commonDir })
      .startsWith(`gg init kept the existing configuration and wrote none of the example: ${file} exists.\n`),
  );
  assert.deepEqual(readdirSync(repositoryDirectory(repo)), ['gg.json']);
  assert.equal(readFileSync(file, 'utf8'), kept);
});

test('gg init writes nothing over any file it would write', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  mkdirSync(repositoryDirectory(repo), { recursive: true });
  const red = join(repositoryDirectory(repo), 'red.md');
  writeFileSync(red, '# our own red Brief\n');
  assert.ok(
    doctor
      .init(repo, { baseBranch: 'main', userDirectory: user, commonDir })
      .startsWith(`gg init kept the existing configuration and wrote none of the example: ${red} exists.\n`),
  );
  assert.deepEqual(readdirSync(repositoryDirectory(repo)), ['red.md']);
});

// A clone whose configuration is committed still needs gg init once: gg.db is not committed (#150).
test('gg init creates the State Database when it keeps the existing configuration', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  mkdirSync(repositoryDirectory(repo), { recursive: true });
  writeFileSync(join(repositoryDirectory(repo), 'gg.json'), '{}\n');
  const text = doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir });
  assert.ok(text.includes(`\ngg init created the State Database at ${dbPath(commonDir)}.\n`), text);
  assert.deepEqual(record.loadAll(commonDir, 'ticket'), [], 'the State Database opens');
});

// gg init is safe to repeat (owner, 2026-11-06): it never recreates a database, so no Execution is forgotten.
test('gg init keeps an existing State Database and the records it holds, and says so', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir });
  record.save(knownRecord(commonDir));
  const text = doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir });
  assert.ok(text.includes(`\ngg init kept the State Database at ${dbPath(commonDir)}.\n`), text);
  assert.equal(record.load(commonDir, 'ticket', 7)?.ticket, 7, 'the record is kept');
});

// A gg.db at `version`, in rollback journal mode, as another gg or a crash could leave one; its bytes, to show gg init
// leaves it untouched.
function databaseAtVersion(commonDir: string, version: number): Buffer {
  mkdirSync(join(commonDir, 'gg'), { recursive: true });
  const db = new DatabaseSync(dbPath(commonDir));
  db.exec(`CREATE TABLE records (kind TEXT, n INTEGER, json TEXT); PRAGMA user_version = ${version}`);
  db.close();
  return readFileSync(dbPath(commonDir));
}

// The person decides what happens to a database no command can open (owner, #150 Q2): it may hold records, and it is
// the evidence of what went wrong.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('gg init refuses a State Database from a newer gg, telling the person to run the gg that wrote it, and leaves it untouched', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  const bytes = databaseAtVersion(commonDir, 2);
  assert.throws(() => doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir }), {
    message:
      `${dbPath(commonDir)} has database version 2; this gg reads version 1\n` +
      'gg init kept it untouched: run the gg that wrote it.',
  });
  assert.deepEqual(readFileSync(dbPath(commonDir)), bytes, 'the file is untouched');
  assert.deepEqual(readdirSync(join(commonDir, 'gg')), ['gg.db'], 'nothing is written beside it');
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('gg init refuses a State Database it cannot read, telling the person to move it aside and keep it, and leaves it untouched', (t) => {
  const { repo, user, commonDir } = initRoots(t);
  const bytes = databaseAtVersion(commonDir, 0);
  assert.throws(() => doctor.init(repo, { baseBranch: 'main', userDirectory: user, commonDir }), {
    message:
      `${dbPath(commonDir)} has database version 0; this gg reads version 1\n` +
      'gg init kept it untouched: move it aside and keep it, since it may hold Execution Records and shows what ' +
      'went wrong, then run gg init again to create a new one.',
  });
  assert.deepEqual(readFileSync(dbPath(commonDir)), bytes, 'the file is untouched');
  assert.deepEqual(readdirSync(join(commonDir, 'gg')), ['gg.db'], 'nothing is written beside it');
});

// This repository's configuration was merged by hand from gg init's output (#120), so it runs on the example's own
// Flow.
test(
  "this repository's configuration is the example with its own commands and testPaths, " + 'and gg doctor accepts it',
  async (t) => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const own = JSON.parse(readFileSync(join(repositoryDirectory(repoRoot), 'gg.json'), 'utf8')) as object;
    const example = JSON.parse(exampleLayer.fixtureText('gg.json')) as object;
    assert.deepEqual(
      { ...own, commands: undefined, testPaths: undefined },
      { ...example, commands: undefined, testPaths: undefined },
    );
    for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
      assert.equal(
        readFileSync(join(repositoryDirectory(repoRoot), name), 'utf8'),
        exampleLayer.fixtureText(name),
        name,
      );
    const { user } = initRoots(t);
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'gg.json'), JSON.stringify(MACHINE_SETTINGS));
    const { text, exitCode } = await doctorOver(repoRoot, user);
    assert.equal(exitCode, 0, text);
    assert.match(text, /\n0 errors, 2 warnings\n$/);
  },
);

// The repository commits each Agent's harness, so gg init alone gives a Flow gg doctor accepts (ADR 0022).
test("the example's Agents name a harness", () => {
  const { agents } = JSON.parse(exampleLayer.fixtureText('gg.json')) as { agents: unknown };
  assert.deepEqual(agents, {
    implementer: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude' },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'claude' },
    senior: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude' },
  });
});
