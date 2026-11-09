import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as afterPhase from '../support/after-phase.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as crashFs from '../support/crash-fs.ts';
import * as gitShell from '../support/git-shell.ts';
import * as resetInterruption from '../support/reset-interruption.ts';

type GoldenFixture = golden.GoldenFixture;
type Crash = Parameters<typeof crashFs.crashFs>[2];

// The baseline an Integrity Violation's rollback restores: ignored Protected Files, an untracked test git clean
// removes, and an ignored file outside the rollback, which the agent changes and the restore must leave alone.
const RESTORED = {
  '.claude/.gitignore': '*\n',
  '.claude/settings.local.json': '{"owner":true}\n',
  'test/owner.test.mjs': 'owner\n',
};
// Where restoreUntracked is crashed: it removes the extra .claude/agent.json, then rewrites settings.local.json and
// recreates test/owner.test.mjs.
const RESTORE_CRASHES: Record<string, Crash> = {
  'after deleting an extra': { op: 'rm', path: '.claude/agent.json', after: true },
  'after removing a destination before its rewrite': { op: 'rm', path: '.claude/settings.local.json', after: true },
  'after the first restored file': { op: 'writeFile', path: '.claude/settings.local.json', after: true },
  'after the final write before evidence': { op: 'writeFile', path: 'test/owner.test.mjs', after: true },
};

async function crashedRestore(t: TestContext, crash: Crash) {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  for (const [path, text] of Object.entries(RESTORED)) {
    mkdirSync(join(fixture.worktree, path, '..'), { recursive: true });
    writeFileSync(join(fixture.worktree, path), text);
  }
  // A tdd Visit starts clean, so the untracked test stays ignored until red runs; git clean then removes it.
  const exclude = join(fixture.commonDir, 'info', 'exclude');
  writeFileSync(exclude, 'scratch.log\ntest/owner.test.mjs\n');
  writeFileSync(join(fixture.worktree, 'scratch.log'), 'owner log\n');
  afterPhase.afterPhase(fixture, 'red', () => {
    writeFileSync(join(fixture.worktree, '.claude', 'settings.local.json'), '{"agent":true}\n');
    writeFileSync(join(fixture.worktree, '.claude', 'agent.json'), '{}\n');
    writeFileSync(join(fixture.worktree, 'scratch.log'), 'agent log\n');
    writeFileSync(exclude, 'scratch.log\n');
  });
  const git = fixture.options.deps.git;
  const noted = resetInterruption.notedReset(git);
  fixture.options.deps.git = noted.git;
  fixture.options.deps.integrity = integrity.createIntegrity(
    fixture.options.deps.git,
    crashFs.crashFs(fixture.worktree, noted.reset, crash),
  );
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  return { ...fixture, uncrashedGit: git, loaded: executionReads.loadTicket(fixture) };
}

const read = (fixture: GoldenFixture, path: string) =>
  existsSync(join(fixture.worktree, path)) ? readFileSync(join(fixture.worktree, path), 'utf8') : null;
const restoredFiles = (fixture: GoldenFixture) => ({
  '.claude/.gitignore': read(fixture, '.claude/.gitignore'),
  '.claude/settings.local.json': read(fixture, '.claude/settings.local.json'),
  'test/owner.test.mjs': read(fixture, 'test/owner.test.mjs'),
});

// The worktree and record a finished restore leaves.
function assertRestored(fixture: GoldenFixture, executionRecord: record.ExecutionRecord) {
  assert.deepEqual(restoredFiles(fixture), RESTORED);
  assert.equal(read(fixture, '.claude/agent.json'), null, 'the extra is removed');
  assert.equal(read(fixture, 'scratch.log'), 'agent log\n', 'an ignored file outside the rollback is untouched');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), fixture.base);
  assert.deepEqual(
    executionRecord.history.map((item) => item.kind),
    ['integrity violation'],
  );
  assert.deepEqual(crashResume.resetEntries(executionRecord), ['intent', 'evidence', 'complete']);
}

// A case each, as golden.fixture restores its process seams when its own test ends.
for (const [name, crash] of Object.entries(RESTORE_CRASHES)) {
  test(`an interrupted restore resumes from mixed left, absent and baseline files: crash ${name}`, async (t) => {
    const crashed = await crashedRestore(t, crash);
    assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit }), 'continue');
    assertRestored(crashed, crashed.loaded);
    assert.equal(
      await reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit }),
      'continue',
      'a further Reconciliation',
    );
    assertRestored(crashed, crashed.loaded);
  });
}

test('a second crash during restore replay remains resumable', async (t) => {
  const crashed = await crashedRestore(t, RESTORE_CRASHES['after deleting an extra'] as Crash);
  const crashing = integrity.createIntegrity(
    crashed.uncrashedGit,
    crashFs.crashFs(crashed.worktree, () => true, {
      op: 'writeFile',
      path: '.claude/settings.local.json',
      after: true,
    }),
  );
  await assert.rejects(
    reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit, integrity: crashing }),
    (err) => err instanceof interpreter.CrashError,
  );
  const loaded = executionReads.loadTicket(crashed);
  assert.deepEqual(crashResume.resetEntries(loaded), ['intent']);
  assert.equal(await reconcile.resets(loaded, { git: crashed.uncrashedGit }), 'continue');
  assertRestored(crashed, loaded);
  assert.equal(await reconcile.resets(loaded, { git: crashed.uncrashedGit }), 'continue', 'a further Reconciliation');
  assertRestored(crashed, loaded);
});

test('unknown ignored contents hold a partial restore without changing files', async (t) => {
  const crashed = await crashedRestore(t, RESTORE_CRASHES['after removing a destination before its rewrite'] as Crash);
  writeFileSync(join(crashed.worktree, '.claude', 'settings.local.json'), '{"human":true}\n');
  const paths = [...Object.keys(RESTORED), '.claude/agent.json', 'scratch.log'];
  const before = paths.map((path) => read(crashed, path));

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit }), 'held');
  assert.deepEqual(
    paths.map((path) => read(crashed, path)),
    before,
    'nothing is restored or removed',
  );
  assert.deepEqual(crashed.loaded.history, []);
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);
});

test('restored non-ignored baseline files are recognised at admission', async (t) => {
  const crashed = await crashedRestore(t, RESTORE_CRASHES['after the final write before evidence'] as Crash);
  assert.equal(read(crashed, 'test/owner.test.mjs'), RESTORED['test/owner.test.mjs'], 'the untracked test is back');
  assert.equal(
    await reconcile.dirtyState(crashed.loaded, { git: crashed.uncrashedGit, worktree: crashed.worktree }),
    null,
  );
  writeFileSync(join(crashed.worktree, 'notes.txt'), 'mine\n');
  const held = await reconcile.dirtyState(crashed.loaded, { git: crashed.uncrashedGit, worktree: crashed.worktree });
  assert.match(held?.stat ?? '', /notes\.txt \(untracked\)/, 'an unrelated untracked addition still holds');
});
