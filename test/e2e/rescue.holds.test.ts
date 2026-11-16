// Every hold that names Rescue Refs, reached with red's Action interrupted (#68, D5, D6, D8, D10): a ref it says keeps
// work is in git at its rescue's commit, each earlier interrupted Attempt's ref that was made is named with its
// Attempt, and no other rescue is named.
import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as exec from '../../lib/exec.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as rescue from '../../lib/rescue.ts';
import * as run from '../../lib/run.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';
import * as golden from '../support/golden.ts';
import * as interruptedCall from '../support/interrupted-call.ts';
import * as runFixture from '../support/run-fixture.ts';

type GoldenFixture = golden.GoldenFixture;
type ExecutionRecord = record.ExecutionRecord;
const TWICE: Record<number, interruptedCall.Interruption> = { 1: 'job', 2: 'job' };

// How far the Executions before the hold got: red's call interrupted twice; interrupted n times, then gg died with
// Attempt n's rescue intended and its ref not yet made; or interrupted twice, then gg died with Attempt 2's reset
// intended.
type State = 'twice' | 'unproven 1' | 'unproven 2' | 'reset intended';
const STATES: State[] = ['twice', 'unproven 1', 'unproven 2'];
type CrashAt = (executionRecord: ExecutionRecord) => { marker: string; point: 'before-effect' };
type Step = (crashAt?: CrashAt) => Promise<void>;

const markerOf = (executionRecord: ExecutionRecord, action: string, attempt: number) =>
  golden.markerOf(executionRecord, 'red', 1, action, 0, attempt);
const refAt = (executionRecord: ExecutionRecord, attempt: number) =>
  rescue.rescueRef(markerOf(executionRecord, 'interrupted-rescue', attempt));
// The commit a ref holds, or '' when git has no such ref.
const target = (worktree: string, ref: string) => gitShell.sh(worktree, 'for-each-ref', '--format=%(objectname)', ref);
const IDENTITY = ['-c', 'user.name=gg test', '-c', 'user.email=gg@example.invalid'];

// Runs the Executions `state` names; gives the Attempt whose call is open at the hold.
async function reach(state: State, step: Step, fixture: { worktree: string; commonDir: string }): Promise<number> {
  const interruptions = state === 'unproven 1' ? 1 : 2;
  for (let index = 0; index < interruptions; index += 1) await step();
  if (state === 'twice') return interruptions;
  const action = state === 'reset intended' ? 'interrupted-reset' : 'interrupted-rescue';
  await step((executionRecord) => ({
    marker: markerOf(executionRecord, action, interruptions),
    point: 'before-effect',
  }));
  if (state !== 'reset intended') {
    const ref = refAt(executionReads.loadTicket(fixture), interruptions);
    assert.equal(target(fixture.worktree, ref), '', `the crash came before ${ref} was made`);
  }
  return interruptions;
}

const goldenStep =
  (fixture: GoldenFixture): Step =>
  (crashAt) =>
    interruptedCall.crashed(fixture, crashAt ? { crashAt: crashAt(fixture.executionRecord) } : {});

function runStep(fixture: runFixture.RunFixture): Step {
  const seeded = { resume: false };
  return async (crashAt) => {
    await runFixture.seedExecution(fixture, { crashAt, resume: seeded.resume });
    seeded.resume = true;
  };
}

// Two finished rescues no hold of red's Action may name, each ref made: a routed rescue of the same Visit and an
// Interrupted Attempt's rescue of another Visit (D10).
function seedUnrelated(worktree: string, executionRecord: ExecutionRecord): string[] {
  const head = gitShell.sh(worktree, 'rev-parse', 'HEAD');
  const tree = gitShell.sh(worktree, 'rev-parse', 'HEAD^{tree}');
  const markers = [
    markerOf(executionRecord, 'rescue', 1),
    golden.markerOf(executionRecord, 'red', 2, 'interrupted-rescue'),
  ];
  return markers.map((actionMarker) => {
    const commit = gitShell.sh(worktree, ...IDENTITY, 'commit-tree', tree, '-p', head, '-m', 'unrelated rescue');
    const ref = rescue.rescueRef(actionMarker);
    gitShell.sh(worktree, 'update-ref', ref, commit);
    executionRecord.writeAheadLog.push(
      writeAhead.entryOf('intent', actionMarker, 'rescue', {
        payload: { ref, commit, tree, parent: head, left: { head, index: tree, tree } },
      }),
      writeAhead.entryOf('evidence', actionMarker, 'rescue', { evidence: { ref, commit } }),
      writeAhead.entryOf('complete', actionMarker, 'rescue'),
    );
    return ref;
  });
}

// A hold's text, the record it was decided on, the refs of the Attempts it must name once made (Attempt 1 first) and
// the unrelated refs.
interface Held {
  text: string;
  executionRecord: ExecutionRecord;
  worktree: string;
  named: string[];
  unrelated: string[];
}

// The refs of red's Attempts before `upTo`, and the unrelated ones, seeded into `executionRecord` before the hold.
function beforeHold(worktree: string, executionRecord: ExecutionRecord, upTo: number) {
  const named = Array.from({ length: upTo - 1 }, (_, index) => refAt(executionRecord, index + 1));
  return { worktree, named, unrelated: seedUnrelated(worktree, executionRecord) };
}

function assertNamesRefs({ text, executionRecord, worktree, named, unrelated }: Held) {
  const intended = new Map(
    executionReads.intents(executionRecord, 'rescue').map(({ payload }) => {
      const { ref, commit } = payload as { ref: string; commit: string };
      return [ref, commit];
    }),
  );
  for (const [, ref] of text.matchAll(/(refs\/gg\/rescue\/[0-9a-f]+) keeps/g))
    assert.equal(target(worktree, ref!), intended.get(ref!), `${ref} is in git at its rescue's commit: ${text}`);
  for (const [index, ref] of named.entries())
    assert.ok(text.includes(`${ref} keeps the work of Attempt ${index + 1} of red at red`), text);
  for (const ref of unrelated) assert.ok(!text.includes(ref), `${ref} is not red's Action's: ${text}`);
}

// Admission, through gg run: the Ticket's worktree changed by `hand` after the Executions `state` names.
async function admissionHold(t: TestContext, state: State, name: string, hand: (worktree: string) => void) {
  const responses = interruptedCall.interruptedResponses(TWICE, { files: { 'notes.txt': 'what red tried\n' } });
  const labels = [executionContext.IN_PROGRESS_LABEL];
  const fixture = runFixture.fixture(t, { responses, labels, integrity: 'real', git: 'real' });
  interruptedCall.interrupting(fixture.harness, TWICE);
  const current = await reach(state, runStep(fixture), fixture);
  hand(fixture.worktree);
  const seeded = executionReads.loadTicket(fixture);
  const before = beforeHold(fixture.worktree, seeded, current);
  record.save(seeded);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  const executionRecord = executionReads.loadTicket(fixture);
  assert.equal(executionRecord.terminalReason?.decidedBy.hold, name);
  return { ...before, text: executionRecord.terminalReason?.text ?? '', executionRecord };
}

// Reconciliation of the record the Executions `state` names leave, after `hand`, against `flow`.
async function reconciliationHold(
  t: TestContext,
  state: State,
  {
    hand = () => {},
    flow = (fixture) => fixture.flow,
  }: {
    hand?: (fixture: GoldenFixture, executionRecord: ExecutionRecord, current: number) => void;
    flow?: (fixture: GoldenFixture) => GoldenFixture['flow'];
  },
): Promise<Held> {
  const fixture = await interruptedCall.interruptedFixture(t, TWICE);
  const current = await reach(state, goldenStep(fixture), fixture);
  const executionRecord = executionReads.loadTicket(fixture);
  hand(fixture, executionRecord, current);
  const before = beforeHold(fixture.worktree, executionRecord, current);

  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, executionRecord, flow(fixture)));
  assert.equal(decided.next, 'hold');
  return { ...before, text: decided.reason ?? '', executionRecord };
}

// The recovery of red's second interrupted Attempt, after `hand`. With `namesCurrent`, the hold names that Attempt's
// ref too, which its rescue made.
async function recoveryHold(
  t: TestContext,
  {
    interrupted = TWICE,
    hand = () => {},
    namesCurrent = false,
  }: { interrupted?: typeof TWICE; hand?: (fixture: GoldenFixture) => void; namesCurrent?: boolean },
): Promise<Held> {
  const fixture = await interruptedCall.interruptedFixture(t, interrupted);
  await interruptedCall.crashed(fixture);
  await interruptedCall.crashed(fixture);
  const seeded = executionReads.loadTicket(fixture);
  const before = beforeHold(fixture.worktree, seeded, namesCurrent ? 3 : 2);
  record.save(seeded);
  hand(fixture);

  const result = await interruptedCall.resumed(fixture);
  assert.equal(result.held, true, JSON.stringify(result));
  const executionRecord = executionReads.loadTicket(fixture);
  assert.equal(executionRecord.terminalReason?.decidedBy.hold, 'interrupted-attempt');
  return { ...before, text: executionRecord.terminalReason?.text ?? '', executionRecord };
}

const failingReset = (fixture: GoldenFixture) => {
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    resetTo: async () => {
      throw new exec.CommandError('git reset failed', { code: 1, stdout: '', stderr: 'Permission denied' });
    },
  };
};
// `verb` runs, then something writes a file into the worktree.
function writesAfter(fixture: GoldenFixture, verb: 'createRef' | 'resetTo') {
  const git = fixture.options.deps.git;
  const real = git[verb] as (...args: unknown[]) => Promise<unknown>;
  fixture.options.deps.git = {
    ...git,
    [verb]: async (...args: unknown[]) => {
      const done = await real(...args);
      writeFileSync(join(fixture.worktree, 'late.txt'), 'written after the rescue\n');
      return done;
    },
  };
}

// The Procedure's hash changed, or red is gone from the Flow.
const changedProcedure = (fixture: GoldenFixture) => ({
  ...fixture.flow,
  procedures: new Map([...fixture.flow.procedures].map(([name, procedure]) => [name, { ...procedure, hash: 'new' }])),
});
const withoutRed = (fixture: GoldenFixture) => ({
  ...fixture.flow,
  ticket: {
    ...fixture.flow.ticket,
    vertices: new Map([...fixture.flow.ticket.vertices].filter(([name]) => name !== 'red')),
  },
});
// gg's last commit is recorded at HEAD, then a person commits on top of it.
function movedTip(fixture: GoldenFixture, executionRecord: ExecutionRecord) {
  const sha = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
  const actionMarker = golden.markerOf(executionRecord, 'red', 1, 'commit');
  executionRecord.writeAheadLog.push(
    writeAhead.entryOf('intent', actionMarker, 'commit'),
    writeAhead.entryOf('evidence', actionMarker, 'commit', { evidence: { sha } }),
    writeAhead.entryOf('complete', actionMarker, 'commit'),
  );
  gitShell.sh(fixture.worktree, ...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'by hand');
}

interface Row {
  name: string;
  reason: RegExp;
  held: (t: TestContext) => Promise<Held>;
}

const admissionRows = (state: State): Row[] => [
  {
    name: `admission's dirty worktree, ${state}`,
    reason: /uncommitted changes the Execution Record does not account for/,
    held: (t) =>
      admissionHold(t, state, 'dirty-worktree', (worktree) => {
        writeFileSync(join(worktree, 'human.txt'), 'mine\n');
        gitShell.sh(worktree, 'add', 'human.txt');
      }),
  },
  {
    name: `admission's merge conflict, ${state}`,
    reason: /merge conflict/,
    held: (t) => admissionHold(t, state, 'merge-conflict', (worktree) => runFixture.conflict(worktree)),
  },
  {
    name: `admission's branch mismatch, ${state}`,
    reason: /ticket\/99-other/,
    held: (t) =>
      admissionHold(t, state, 'branch-mismatch', (worktree) =>
        gitShell.sh(worktree, 'checkout', '-q', '-b', 'ticket/99-other'),
      ),
  },
];

const reconciliationRows = (state: State): Row[] => [
  {
    name: `Reconciliation's moved branch tip, ${state}`,
    reason: /so it was changed by hand/,
    held: (t) => reconciliationHold(t, state, { hand: movedTip }),
  },
  {
    name: `Reconciliation's missing Vertex, ${state}`,
    reason: /which the Flow no longer has/,
    held: (t) => reconciliationHold(t, state, { flow: withoutRed }),
  },
  {
    name: `Reconciliation's changed Procedure, ${state}`,
    reason: /the configuration has changed it since/,
    held: (t) => reconciliationHold(t, state, { flow: changedProcedure }),
  },
];

const ROWS: Row[] = [
  ...STATES.flatMap((state) => [...admissionRows(state), ...reconciliationRows(state)]),
  {
    name: "Reconciliation's refused reset, reset intended",
    reason: /An interrupted reset did not leave the worktree clean/,
    held: (t) =>
      reconciliationHold(t, 'reset intended', {
        hand: (fixture) => writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n'),
      }),
  },
  ...(['unproven 1', 'unproven 2'] as const).map((state) => ({
    name: `Reconciliation's conflicting Effect, ${state}`,
    reason: /, not the intended /,
    held: (t: TestContext) =>
      reconciliationHold(t, state, {
        hand: (fixture, executionRecord, current) =>
          gitShell.sh(fixture.worktree, 'update-ref', refAt(executionRecord, current), 'HEAD'),
      }),
  })),
  {
    name: "the recovery's moved index",
    reason: /HEAD or the index moved since the Visit's baseline/,
    held: (t) => recoveryHold(t, { hand: (fixture) => gitShell.sh(fixture.worktree, 'add', 'notes.txt') }),
  },
  {
    name: "the recovery's ref verification",
    reason: /does not match the worktree/,
    held: (t) => recoveryHold(t, { hand: (fixture) => writesAfter(fixture, 'createRef') }),
  },
  {
    name: "the recovery's failed reset",
    reason: /failed: git reset failed/,
    held: async (t) => {
      const held = await recoveryHold(t, { hand: failingReset });
      const current = refAt(held.executionRecord, 2);
      assert.ok(held.text.includes(`Rescue Ref ${current} keeps the work`), `the hold names ${current}: ${held.text}`);
      return held;
    },
  },
  {
    name: "the recovery's reset not at its baseline",
    reason: /did not leave the worktree at its baseline/,
    held: (t) => recoveryHold(t, { hand: (fixture) => writesAfter(fixture, 'resetTo') }),
  },
  {
    name: "the recovery's ref conflict",
    reason: /already holds/,
    held: (t) =>
      recoveryHold(t, {
        hand: (fixture) => gitShell.sh(fixture.worktree, 'update-ref', refAt(fixture.executionRecord, 2), 'HEAD'),
      }),
  },
  {
    name: "the recovery's uncontained call",
    reason: /outside a job that ends its processes/,
    held: (t) => recoveryHold(t, { interrupted: { 1: 'job', 2: 'none' }, namesCurrent: true }),
  },
  {
    name: "the recovery's exhausted crash budget",
    reason: /again after its crash retry/,
    held: async (t) => {
      const ran: { fixture?: GoldenFixture } = {};
      const hand = (fixture: GoldenFixture) => {
        ran.fixture = fixture;
      };
      const held = await recoveryHold(t, { hand, namesCurrent: true });
      const made = gitShell.sh(held.worktree, 'for-each-ref', '--format=%(refname)', 'refs/gg/rescue').split('\n');
      const own = made.filter((ref) => ref && !held.unrelated.includes(ref));
      assert.deepEqual(own.sort(), [...held.named].sort(), 'git holds one Rescue Ref per interrupted Attempt');
      assert.equal(existsSync(join(held.worktree, 'notes.txt')), false, 'the second Attempt was reset before the hold');
      assert.equal(interruptedCall.crashBudget(ran.fixture!), 1);
      assert.equal(interruptedCall.redCalls(ran.fixture!).length, 2);
      return held;
    },
  },
];

for (const row of ROWS)
  test(`a hold names only made Rescue Refs, each with its Attempt: ${row.name}`, async (t) => {
    const held = await row.held(t);
    assert.match(held.text, row.reason);
    assertNamesRefs(held);
  });
