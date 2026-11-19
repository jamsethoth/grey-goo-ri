import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as reset from '../../lib/effects/reset.ts';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as effectFixture from '../support/effect-fixture.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as keys from '../support/keys.ts';
import * as namedFlow from '../support/named-flow.ts';
import * as pinnedValue from '../support/pinned-value.ts';
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
  assert.throws(
    () => reconcile.loadExecutionRecord(commonDir, 1, stateDatabase),
    (err: Error) => !(err instanceof record.RecordCorruptError) && /unable to open database file/.test(err.message),
  );
});

test('a corrupt row loads as corrupt, not as an error', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-reconcile-');
  stateDatabase.open(commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', 1, '{')").run();
  const loaded = reconcile.loadExecutionRecord(commonDir, 1, stateDatabase);
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
  const executionRecord = record.load(fixture.commonDir, 'ticket', golden.TICKET) as record.ExecutionRecord;
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

  const loaded = record.load(fixture.commonDir, 'ticket', golden.TICKET) as record.ExecutionRecord;
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

// Reconciliation finishes open resets before it looks for any other intent, which would hold a reset as an effect it
// does not recognise.
test('an open reset is finished before any intent is looked for, so the Ticket continues', async (t) => {
  const given = await effectFixture.effectFixture(t);
  given.write('extra.txt', 'left by the agent\n');
  const left = await given.context.integrity.snapshot(given.worktree);
  const history = { kind: 'integrity violation', text: 'The agent wrote outside its scope.' };
  const actionMarker = given.markerOf('reset');
  given.database.intent(given.executionRecord, actionMarker, reset.effect.name, {
    baseline: given.fixture.base,
    history,
    left: { ...left, files: {} },
  });
  const decided = await reconcile.reconcile({
    ...crashResume.reconcileOptions(given.fixture, given.executionRecord),
    database: given.database,
  });
  assert.equal(decided.next, 'continue', JSON.stringify(decided));
  assert.deepEqual(executionReads.writeAheadSteps(given.executionRecord, actionMarker), [
    'intent',
    'evidence',
    'complete',
  ]);
  assert.deepEqual(given.executionRecord.history, [history]);
});

test('an unknown intent effect holds', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.options.deps.database!.intent(fixture.executionRecord, 'gg:someone-elses', 'teleport', {
    branch: 'ticket/8',
    sha: 'abc',
  });
  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, fixture.executionRecord));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason as string, /teleport/);
});

test('a finder-less replay-safe action replays', async (t) => {
  const fixture = await golden.fixture(t);
  fixture.options.deps.database!.intent(fixture.executionRecord, 'gg:pr-ready', 'pr-ready', {
    number: 1,
    sha: null,
    tree: null,
  });
  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, fixture.executionRecord));
  assert.equal(decided.next, 'continue');
  assert.deepEqual(executionReads.writeAheadSteps(fixture.executionRecord, 'gg:pr-ready'), ['intent']);
});

test('a record at a Vertex named constructor resumes, and one the Flow lacks holds', async (t) => {
  const names = namedFlow.PROTOTYPE;
  // Crashed after the commit of the Visit to the Vertex named constructor, then resumed: the same as the ordinary
  // Flow's restart, renamed.
  const ordinary = await namedFlow.restartNamed(t, namedFlow.ORDINARY);
  assert.equal(ordinary.result.outcome, 'ready-for-qa');
  assert.deepEqual(await namedFlow.restartNamed(t, names), namedFlow.renamed(ordinary));

  const held = await namedFlow.namedFixture(t, names);
  await crashResume.crashed(held, [names.first, 1, names.commit, 0], 'after-completion');
  // The same Flow with that Vertex renamed, so the record continues at a Vertex the Flow lacks.
  const lacking = golden.resolve(namedFlow.namedConfig({ ...names, first: 'builder' }));
  const ended = await interpreter.runExecution({
    ...held.options,
    pinned: pinnedValue.withFlow(held.options.pinned, lacking),
    record: executionReads.loadTicket(held),
  });
  assert.deepEqual([ended.outcome, ended.held], ['needs-human', true]);
  assert.match(
    executionReads.loadTicket(held).terminalReason!.text,
    /The record continues at Vertex constructor, which the Flow no longer has\./,
  );
});

// Every way a resumed Visit's Harness can differ from what its Config Hash pinned, made on the Harness that runs, with
// this Run's Flow still on that Harness or moved to another, at each resume point that reaches an agent call (#428 D1).
const PINNED_FAKE = { name: 'fake-headless', version: 1, confinement: 'none' };
const MOVED = { other: { name: 'other-headless', version: 1, confinement: 'none' } };
const RETRIED = {
  ...golden.firstVisitResponses,
  [keys.responseKey({ vertex: 'green', visit: 1, action: 'green' })]: {
    failure: { failureClass: 'transient' as const, retryAfterMs: 0 },
  },
  [keys.responseKey({ vertex: 'green', visit: 1, action: 'green', attempt: 2 })]: {
    files: { 'lib/add.mjs': goldenRun.RIGHT_ADD },
    response: golden.greenResponse,
  },
};
const CHANGES = [
  ['launch profile changed is held before any agent call', { launchProfile: { name: 'fake-headless', version: 2 } }],
  ['confinement changed is held before any agent call', { capabilities: { confinement: 'trusted-commands' } }],
  ['launch profile and confinement unchanged continues', null],
] as const;
for (const [change, harnessNow] of CHANGES)
  for (const moved of [false, true])
    for (const pending of [false, true]) {
      const where = `${moved ? 'moved to another Harness' : 'still on it'}, ${pending ? 'an agent call pending' : 'after the commit'}`;
      test(`a resumed Visit whose Harness's ${change}, its Flow ${where}`, async (t) => {
        const fixture = await golden.fixture(t, pending ? { responses: RETRIED } : {});
        const { pinned } = fixture.options;
        stateDatabase.savePinnedConfiguration(fixture.commonDir, pinned.hash, {
          ...pinned.configuration,
          launchProfile: { fake: PINNED_FAKE },
        });
        Object.assign(fixture.harness, { launchProfile: { name: 'fake-headless', version: 1 } });
        await (pending
          ? crashResume.crashed(fixture, ['green', 1, 'green', 0, 1], 'after-completion')
          : crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-completion'));
        const callsBefore = fixture.harness.calls.length;
        if (harnessNow && 'launchProfile' in harnessNow) Object.assign(fixture.harness, harnessNow);
        if (harnessNow && 'capabilities' in harnessNow)
          Object.assign(fixture.harness.capabilities, harnessNow.capabilities);

        const ended = await interpreter.runExecution({
          ...fixture.options,
          pinned: moved ? { ...pinned, configuration: { ...pinned.configuration, launchProfile: MOVED } } : pinned,
          record: executionReads.loadTicket(fixture),
        });
        const held = harnessNow !== null;
        assert.deepEqual([ended.outcome, ended.held === true], [held ? 'needs-human' : 'ready-for-qa', held]);
        if (held || pending)
          assert.equal(fixture.harness.calls.length - callsBefore, held ? 0 : 1, 'agent calls after the resume');
        if (!held) return;
        assert.match(
          executionReads.loadTicket(fixture).terminalReason!.text,
          /entered with Harness fake's launch profile and confinement as they were then, and this Run has changed them/,
        );
      });
    }
