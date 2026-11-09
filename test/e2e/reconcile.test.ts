import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as afterPhase from '../support/after-phase.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as gitShell from '../support/git-shell.ts';
import * as resetInterruption from '../support/reset-interruption.ts';

// red's Attempt writes a Protected File, an Integrity Violation whose reset is interrupted by a crash at `when`: before
// the reset, or after it.
async function crashedViolation(t: TestContext, when: 'before reset' | 'after reset') {
  const responses = structuredClone(golden.firstVisitResponses);
  (responses['red/1/red/1']?.files as Record<string, string>)['.agents/injected.json'] = '{}\n';
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  const git = fixture.options.deps.git;
  fixture.options.deps.git = resetInterruption.crashingReset(git, { after: when === 'after reset' });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  return { ...fixture, loaded: executionReads.loadTicket(fixture), uncrashedGit: git };
}

test('a crash after the reset of an Integrity Violation keeps its History item exactly once', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  assert.deepEqual(crashed.loaded.history, [], 'the crash came before the History item was saved');
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'continue');
  // Read again: the first assertion narrowed the record's own History to empty.
  const history: record.ExecutionRecord['history'] = crashed.loaded.history;
  assert.equal(history.length, 1);
  assert.equal(history[0]?.kind, 'integrity violation');
  assert.match(history[0]?.text as string, /changed protected/);
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent', 'evidence', 'complete']);
  assert.deepEqual(writeAhead.openIntents(crashed.loaded), []);

  const saved = executionReads.loadTicket(crashed);
  assert.deepEqual(saved.history, crashed.loaded.history, 'the History item is persisted');
  assert.equal(await reconcile.resets(saved, { git: crashed.options.deps.git }), 'continue');
  assert.equal(saved.history.length, 1, 'a second Reconciliation adds nothing');
});

test('a crash before the reset is finished by Reconciliation while the worktree is as the agent left it', async (t) => {
  const crashed = await crashedViolation(t, 'before reset');
  assert.notEqual(
    gitShell.sh(crashed.worktree, 'status', '--porcelain'),
    '',
    'the agent changes are still in the worktree',
  );

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit }), 'continue');
  assert.equal(
    gitShell.sh(crashed.worktree, 'status', '--porcelain'),
    '',
    "the record proves the changes the agent's, so they are discarded",
  );
  assert.deepEqual(
    crashed.loaded.history.map((item) => item.kind),
    ['integrity violation'],
  );
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent', 'evidence', 'complete']);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a crash before the reset holds the Execution and discards nothing once a human changed the worktree', async (t) => {
  const crashed = await crashedViolation(t, 'before reset');
  writeFileSync(join(crashed.worktree, 'human.txt'), 'mine\n');
  const dirty = gitShell.sh(crashed.worktree, 'status', '--porcelain');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.equal(gitShell.sh(crashed.worktree, 'status', '--porcelain'), dirty, 'nothing is discarded at resume');
  assert.deepEqual(crashed.loaded.history, []);
  assert.equal(
    (writeAhead.openIntents(crashed.loaded)[0]?.payload as { history: { kind: string } }).history.kind,
    'integrity violation',
    'the reason waits in the open intent',
  );
});

test('an assume-unchanged edit left at the baseline does not prove the reset done', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  const [tracked] = gitShell.sh(crashed.worktree, 'ls-files').split('\n') as [string];
  gitShell.sh(crashed.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(crashed.worktree, tracked), 'a hidden agent edit\n');
  assert.equal(gitShell.sh(crashed.worktree, 'status', '--porcelain'), '', 'git status cannot see it');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.deepEqual(crashed.loaded.history, []);
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);
});

test('an ignored test added after an interrupted reset holds the restore and is kept', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  writeFileSync(join(crashed.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  mkdirSync(join(crashed.worktree, 'test'), { recursive: true });
  writeFileSync(join(crashed.worktree, 'test', 'human.test.mjs'), 'mine\n');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.equal(
    readFileSync(join(crashed.worktree, 'test', 'human.test.mjs'), 'utf8'),
    'mine\n',
    'the human file is untouched',
  );
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a crash between the reset and the Protected File restore of an integrity violation is finished by Reconciliation', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  mkdirSync(join(fixture.worktree, '.claude'), { recursive: true });
  writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(fixture.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  afterPhase.afterPhase(fixture, 'red', () => writeFileSync(local, '{"agent":true}\n'));
  const git = fixture.options.deps.git;
  fixture.options.deps.git = resetInterruption.crashingReset(git, { after: true });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  assert.equal(readFileSync(local, 'utf8'), '{"agent":true}\n', 'the crash came before the restore');

  const loaded = executionReads.loadTicket(fixture);
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', "the owner's bytes come back from the saved intent");
  assert.equal(loaded.history[0]?.kind, 'integrity violation');
  assert.deepEqual(writeAhead.openIntents(loaded), []);
});

test('Reconciliation uses an injected integrity', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  // The real worktree is clean at the reset's baseline, so only the injected integrity can make it look a human's.
  const elsewhere = { head: 'elsewhere', index: 'elsewhere', tree: 'elsewhere' };
  const injected = {
    snapshot: async () => elsewhere,
    isCleanAt: async () => false,
    untrackedFiles: async () => ({}),
    ignoredFiles: async () => ({}),
  } as unknown as integrity.Integrity;
  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git, integrity: injected }), 'held');
  assert.deepEqual(
    await reconcile.dirtyState(null, {
      git: crashed.options.deps.git,
      worktree: crashed.worktree,
      integrity: injected,
    }),
    { conflicts: [], stat: '', rescueRef: null },
  );
  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'continue');
});
