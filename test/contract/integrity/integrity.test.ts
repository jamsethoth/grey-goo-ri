// The fake integrity's contract: each case runs against lib/integrity.ts and test/support/fake-integrity.ts, so the
// violations the unit tier routes on, the untracked files it rolls back and the Test Immutability it checks keep the
// real shape. The real side runs over real git and the fake side over the git it is given.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as checks from '../../../lib/checks.ts';
import * as integrity from '../../../lib/integrity.ts';
import * as gitModule from '../../../lib/git.ts';
import * as fakeGitModule from '../../support/fake-git.ts';
import * as fakeIntegrityModule from '../../support/fake-integrity.ts';
import * as gitShell from '../../support/git-shell.ts';
import * as worktrees from '../../support/integrity-worktrees.ts';

type Fake = ReturnType<typeof fakeIntegrityModule.fakeIntegrity>;
type Worktrees = Awaited<ReturnType<typeof worktrees.twoWorktrees>>;
type Violation = { worktree: string; surface: string; before: unknown; after: unknown };
type Files = Record<string, unknown>;
// Method signatures, so the untyped lib and fake functions both fit.
type Integrity = {
  takeBaseline(call: object): Promise<object>;
  findViolations(call: object): Promise<{ violations: Violation[] }>;
  untrackedFiles(worktree: string, within: object): Promise<Files>;
  ignoredFiles(worktree: string, within: object): Promise<Files>;
  restoreUntracked(worktree: string, set: object): Promise<void>;
};
type Side = {
  name: string;
  repo(t: TestContext, files: Record<string, string>): { mainRoot: string; base: string; git: object };
  bound(git: object): {
    integrity: Integrity;
    testImmutability(cwd: string, baseline: string, globs: string[]): Promise<{ ok: boolean; changed: string[] }>;
  };
};
type Scenario = {
  name: string;
  access: 'read-only' | 'workspace-write';
  expected: string[][];
  real: (pair: Worktrees) => void;
  fake: (fake: Fake, pair: Worktrees) => void;
};

// One table for both, so the fake cannot drift from the violations the interpreter routes on. `real` acts on the
// worktrees and `fake` scripts the same change; `expected` keeps both from agreeing on nothing.
const SCENARIOS: Scenario[] = [
  { name: 'a clean Attempt', access: 'workspace-write', real: () => {}, fake: () => {}, expected: [] },
  {
    name: 'a tree edit',
    access: 'read-only',
    expected: [['own', 'tree']],
    real: ({ own }) => writeFileSync(join(own, 'notes.txt'), 'agent wrote this\n'),
    fake: (fake, { own }) => fake.write(own, 'notes.txt'),
  },
  {
    name: 'a head move',
    access: 'workspace-write',
    expected: [
      ['own', 'head'],
      ['own', 'index'],
    ],
    real: ({ own }) => {
      writeFileSync(join(own, 'b.txt'), 'b\n');
      gitShell.sh(own, 'add', 'b.txt');
      gitShell.sh(own, 'commit', '-q', '-m', 'agent commit');
    },
    fake: (fake, { own }) => {
      fake.write(own, 'b.txt');
      fake.commit(own);
    },
  },
  {
    name: 'a protected-file write',
    access: 'workspace-write',
    expected: [['own', 'protected']],
    real: ({ own }) => writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n'),
    fake: (fake, { own }) => fake.write(own, 'AGENTS.md'),
  },
  {
    name: 'a sibling write',
    access: 'workspace-write',
    expected: [['other', 'tree']],
    real: ({ other }) => writeFileSync(join(other, 'stray.txt'), 'stray\n'),
    fake: (fake, { other }) => fake.write(other, 'stray.txt'),
  },
];

// What routing reads: the worktree, the surface and that it changed between two object names; a protected violation's
// paths are compared whole.
const shapeOf = (violations: Violation[], names: Record<string, string>) =>
  violations.map(({ worktree, surface, before, after }) => ({
    worktree: names[worktree],
    surface,
    ...(surface === 'protected'
      ? { before, after }
      : { changed: [before, after].every((sha) => /^[0-9a-f]{40}$/.test(String(sha))) && before !== after }),
  }));

for (const scenario of SCENARIOS) {
  test(`the fake integrity reports what the real one reports: ${scenario.name}`, async (t) => {
    const pair = await worktrees.twoWorktrees(t);
    const names = { [pair.own]: 'own', [pair.other]: 'other' };
    const fake = fakeIntegrityModule.fakeIntegrity({ git: gitModule });
    const attempt = async (implementation: Integrity, act: () => void) => {
      const call = {
        record: pair.ownRecord,
        others: [pair.other],
        access: scenario.access,
        protectedPaths: worktrees.PROTECTED,
      };
      const baseline = await implementation.takeBaseline(call);
      act();
      // The baseline is saved in the call intent, so its fields are part of the shape.
      return {
        fields: Object.keys(baseline).sort(),
        violations: shapeOf((await implementation.findViolations({ ...call, baseline })).violations, names),
      };
    };
    const real = await attempt(integrity.createIntegrity(gitModule), () => scenario.real(pair));

    assert.deepEqual(
      real.violations.map((violation) => [violation.worktree, violation.surface]),
      scenario.expected,
    );
    assert.deepEqual(await attempt(fake.integrity, () => scenario.fake(fake, pair)), real);
  });
}

// The Red Check diffs untracked tests against the baseline's, so the fake's must be the real one's.
test('the fake integrity records the untracked tests the real one records', async (t) => {
  const { own, ownRecord } = await worktrees.twoWorktrees(t);
  // An untracked test, an ignored one under a test glob, and an untracked file outside the test paths.
  writeFileSync(join(own, '.git', 'info', 'exclude'), 'test/cache/\n');
  mkdirSync(join(own, 'test', 'cache'), { recursive: true });
  writeFileSync(join(own, 'test', 'new.test.mjs'), 'new\n');
  writeFileSync(join(own, 'test', 'cache', 'out.json'), '{}\n');
  writeFileSync(join(own, 'notes.txt'), 'notes\n');
  const beginArguments = {
    record: ownRecord,
    others: [],
    access: 'workspace-write',
    protectedPaths: worktrees.PROTECTED,
    testPaths: checks.testPathSet(checks.DEFAULT_TEST_GLOBS),
  };
  const real = await integrity.createIntegrity(gitModule).takeBaseline(beginArguments);
  const fake = await fakeIntegrityModule.fakeIntegrity({ git: gitModule }).integrity.takeBaseline(beginArguments);

  assert.deepEqual(Object.keys(real.tests).sort(), ['test/cache/out.json', 'test/new.test.mjs']);
  assert.deepEqual(fake.tests, real.tests);
});

// Each side's repository holds `files` in one commit on main: the real side in real git, the fake side in the fake git
// the unit tier runs on. `bound` is the integrity and Test Immutability a Run gets on that side.
const SIDES: Side[] = [
  {
    name: 'real',
    repo(t: TestContext, files: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const mainRoot = join(root, 'main');
      mkdirSync(mainRoot);
      gitShell.sh(mainRoot, 'init', '-q', '-b', 'main');
      gitShell.sh(mainRoot, 'config', 'user.name', 't');
      gitShell.sh(mainRoot, 'config', 'user.email', 't@t');
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(mainRoot, path, '..'), { recursive: true });
        writeFileSync(join(mainRoot, path), text);
      }
      gitShell.sh(mainRoot, 'add', '-A');
      gitShell.sh(mainRoot, 'commit', '-q', '-m', 'init');
      return { mainRoot, base: gitShell.sh(mainRoot, 'rev-parse', 'HEAD'), git: gitModule };
    },
    bound: (git: object) => ({
      integrity: integrity.createIntegrity(git as integrity.IntegrityGit),
      testImmutability: (cwd: string, baseline: string, globs: string[]) =>
        checks.testImmutability(cwd, baseline, { globs, git: git as checks.ChangedPaths }),
    }),
  },
  {
    name: 'fake',
    repo(t: TestContext, files: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const fake = fakeGitModule.fakeGit();
      return { ...fake.init(root, { files }), git: fake.git };
    },
    bound: (git: object) =>
      fakeIntegrityModule.fakeIntegrity({ git: git as integrity.IntegrityGit & checks.ChangedPaths }),
  },
];

const contract = (name: string, body: (side: Side, t: TestContext) => Promise<void>) => {
  for (const side of SIDES) test(`${name} (${side.name})`, (t) => body(side, t));
};

contract('Test Immutability fails when a protected test file changed', async (side, t) => {
  const { mainRoot, base, git } = side.repo(t, { 'test/add.test.mjs': 'strict\n', 'lib/add.mjs': 'a\n' });
  writeFileSync(join(mainRoot, 'test', 'add.test.mjs'), 'weakened\n');
  writeFileSync(join(mainRoot, 'lib', 'add.mjs'), 'b\n');

  assert.deepEqual(await side.bound(git).testImmutability(mainRoot, base, checks.DEFAULT_TEST_GLOBS), {
    ok: false,
    changed: ['test/add.test.mjs'],
  });
});

contract('Test Immutability passes when only code outside the test paths changed', async (side, t) => {
  const { mainRoot, base, git } = side.repo(t, { 'test/add.test.mjs': 'strict\n', 'lib/add.mjs': 'a\n' });
  writeFileSync(join(mainRoot, 'lib', 'add.mjs'), 'b\n');

  assert.deepEqual(await side.bound(git).testImmutability(mainRoot, base, checks.DEFAULT_TEST_GLOBS), {
    ok: true,
    changed: [],
  });
});

contract('a rollback puts back the untracked and ignored tests it listed', async (side, t) => {
  const { mainRoot, git } = side.repo(t, { '.gitignore': 'test/cache/\n' });
  const bound = side.bound(git).integrity;
  const within = checks.testPathSet(checks.DEFAULT_TEST_GLOBS);
  mkdirSync(join(mainRoot, 'test', 'cache'), { recursive: true });
  writeFileSync(join(mainRoot, 'test', 'new.test.mjs'), 'new\n');
  writeFileSync(join(mainRoot, 'test', 'cache', 'out.json'), '{}\n');
  const files = await bound.untrackedFiles(mainRoot, within);
  assert.deepEqual(Object.keys(await bound.ignoredFiles(mainRoot, within)), ['test/cache/out.json']);
  assert.deepEqual(Object.keys(files).sort(), ['test/cache/out.json', 'test/new.test.mjs']);
  // The agent rewrites one, deletes one and adds one.
  writeFileSync(join(mainRoot, 'test', 'new.test.mjs'), 'weakened\n');
  rmSync(join(mainRoot, 'test', 'cache', 'out.json'));
  writeFileSync(join(mainRoot, 'test', 'extra.test.mjs'), 'extra\n');

  await bound.restoreUntracked(mainRoot, { files, within });
  assert.deepEqual(await bound.untrackedFiles(mainRoot, within), files);
  assert.equal(readFileSync(join(mainRoot, 'test', 'new.test.mjs'), 'utf8'), 'new\n');
});
