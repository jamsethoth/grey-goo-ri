import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as resetInterruption from '../support/reset-interruption.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Ticket branch's log from its head: two commits since the base, the base, and the commit the base was cut from.
const branchLog = [
  { sha: 'c'.repeat(40), message: 'feat: b' },
  { sha: 'b'.repeat(40), message: 'feat: a' },
  { sha: 'a'.repeat(40), message: 'base' },
  { sha: '9'.repeat(40), message: 'before the base' },
];
const onBranch = (base: string) =>
  ({
    worktree: '/wt',
    base,
    options: { deps: { git: { commitLog: async () => branchLog } } },
  }) as unknown as Parameters<typeof executionReads.branchMessages>[0];

test('branchMessages lists the commits since the base, oldest first', async () => {
  assert.deepEqual(await executionReads.branchMessages(onBranch('a'.repeat(40))), ['feat: a', 'feat: b']);
});

test('branchMessages throws when the base is not in the log', async () => {
  await assert.rejects(executionReads.branchMessages(onBranch('d'.repeat(40))), /base d{40} is not in the log/);
});

// Only a corrupt row is held for a human; any other failure to read the record reaches the caller. This case also keeps
// the coverage gate steady: without a process that runs the rethrow, some orders of node's merge of the test processes'
// ranges leave it uncovered (#281).
test('a record the State Database cannot open fails with its error, not as a corrupt record', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-reconcile-');
  mkdirSync(join(commonDir, 'gg', 'gg.db'), { recursive: true });
  await assert.rejects(
    reconcile.loadExecutionRecord(commonDir, 1),
    (err: Error) => !(err instanceof record.RecordCorruptError) && /unable to open database file/.test(err.message),
  );
});

test('a corrupt row loads as corrupt, not as an error', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-reconcile-');
  stateDatabase.open(commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', 1, '{')").run();
  const loaded = await reconcile.loadExecutionRecord(commonDir, 1);
  assert.equal(loaded.executionRecord, null);
  assert.ok(loaded.corrupt instanceof record.RecordCorruptError);
  assert.equal(loaded.corrupt.raw, '{', 'the error keeps the row');
});

// An Integrity Violation at red's Attempt, which a reset rolls back.
const violating = (fixture: golden.GoldenFixture): integrity.Integrity => ({
  ...(fixture.options.deps.integrity as integrity.Integrity),
  findViolations: async () => ({
    violations: [
      { worktree: fixture.worktree, surface: 'head', before: fixture.base, after: 'a'.repeat(40) },
    ] as integrity.IntegrityViolation[],
  }),
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a reset whose evidence was saved but not its completion is completed without a second History item', async (t) => {
  const fixture = await golden.fixture(t);
  await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, integrity: violating(fixture) },
  });
  const executionRecord = (await record.load(fixture.commonDir, 'ticket', golden.TICKET)) as record.ExecutionRecord;
  executionRecord.writeAheadLog = executionRecord.writeAheadLog.filter(
    (entry) => !(entry.effect === 'reset' && entry.step === 'complete'),
  );

  assert.equal(await reconcile.resets(executionRecord, { git: fixture.options.deps.git }), 'continue');
  assert.equal(executionRecord.history.length, 1);
  assert.deepEqual(crashResume.resetEntries(executionRecord), ['intent', 'evidence', 'complete']);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a failed HEAD read after the reset of an Integrity Violation leaves the History item to Reconciliation, once', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.options.deps.integrity = violating(fixture);
  const git = fixture.options.deps.git;
  const noted = resetInterruption.notedReset(git);
  fixture.options.deps.git = {
    ...noted.git,
    headSha: async (cwd) => {
      if (noted.reset()) throw new interpreter.CrashError('head read failed');
      return git.headSha(cwd);
    },
  };
  await assert.rejects(interpreter.runExecution(fixture.options), /head read failed/);

  const loaded = (await record.load(fixture.commonDir, 'ticket', golden.TICKET)) as record.ExecutionRecord;
  assert.deepEqual(loaded.history, [], 'no History item is saved without the reset evidence');
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(loaded.history.length, 1);
});

// A push that landed before the crash is found on the remote by its sha, which Reconciliation saves as its evidence, so
// the resume completes the push rather than making it again.
test('a push that landed before a crash is found by its remote sha', async (t) => {
  const fixture = await golden.fixture(t);
  const { actionMarker, loaded } = await crashResume.crashed(fixture, crashResume.EFFECTS.push.place, 'after-effect');
  const pushed = await executionReads.originSha(fixture);

  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, loaded));
  assert.equal(decided.next, 'continue');
  assert.deepEqual(executionReads.writeAheadSteps(loaded, actionMarker), ['intent', 'evidence']);
  assert.deepEqual(loaded.writeAheadLog.findLast((entry) => entry.actionMarker === actionMarker)?.evidence, {
    remoteSha: pushed,
  });
});
