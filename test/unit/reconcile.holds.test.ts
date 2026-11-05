import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as effectEvidence from '../../lib/effect-evidence.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as sqlite from '../../lib/sqlite.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as reviewFlow from '../support/review-flow.ts';
import * as caseDatabase from '../support/case-database.ts';

const { NEEDS_HUMAN_LABEL } = executionContext;
const CRASH_POINTS = Object.keys(crashResume.POINTS) as (keyof typeof crashResume.POINTS)[];
const ticketEnds = (fixture: golden.GoldenFixture) =>
  fixture.readEvents().filter((event): event is events.TicketEndEvent => event.type === 'ticket_end');
// The golden Flow with its green Vertex renamed, so a record that visited green names a Vertex it no longer has.
function withoutGreen(fixture: golden.GoldenFixture): runContext.RunFlow {
  const flow = structuredClone(fixture.flow);
  flow.ticket.vertices = { builder: flow.ticket.vertices.green as runContext.RunFlow['ticket']['vertices'][string] };
  flow.ticket.entry = 'builder';
  return flow;
}

// Each Terminal kind crashes at its needs-human label (a fault report's Actions are fault-<effect>), then resumes on a
// freshly loaded record with the same options.
for (const point of CRASH_POINTS) {
  test(`a crash ${point} of the held needs-human label keeps the held classification`, async (t) => {
    const fixture = await golden.fixture(t);
    // The completed commit's Vertex is gone from the Flow, so Reconciliation holds the Ticket.
    await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-completion');
    fixture.options.flow = withoutGreen(fixture);
    fixture.options.record = await executionReads.loadTicket(fixture);
    await crashResume.crashed(fixture, ['needs-human', 1, 'hold-label', 0], point);

    const result = await interpreter.runExecution({
      ...fixture.options,
      record: await executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true);
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
    assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
    const ends = ticketEnds(fixture);
    assert.equal(ends.length, 1);
    assert.match(ends[0]?.terminalReason?.text as string, /Vertex green/);
  });
}

for (const point of CRASH_POINTS) {
  test(`a crash ${point} of the fault needs-human label keeps the fault classification`, async (t) => {
    const fixture = await golden.fixture(t);
    const run = fixture.harness.run;
    fixture.harness.run = async (call) => {
      if (call.phase === 'red') throw new Error('the harness exploded');
      return run(call);
    };
    await crashResume.crashed(fixture, ['needs-human', 1, 'fault-label', 0], point);

    const result = await interpreter.runExecution({
      ...fixture.options,
      record: await executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.fault, true);
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
    assert.equal((await executionReads.loadTicket(fixture)).state, 'fault');
    const ends = ticketEnds(fixture);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.error, 'the harness exploded');
  });
}

for (const point of CRASH_POINTS) {
  test(`a crash ${point} of the run stop needs-human label keeps the run stop classification`, async (t) => {
    const fixture = await golden.fixture(t, {
      responses: { 'red/1/red/1': { files: {}, response: null, failure: { failureClass: 'auth' } } },
    });
    await crashResume.crashed(fixture, ['needs-human', 1, 'end-label', 0], point);

    const result = await interpreter.runExecution({
      ...fixture.options,
      record: await executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-human');
    assert.equal((executionReads.runStopEvent(fixture) as { failureClass?: string } | undefined)?.failureClass, 'auth');
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
    assert.equal((await executionReads.loadTicket(fixture)).state, 'needs-human');
    assert.equal(ticketEnds(fixture).length, 1);
  });
}

test('dirtyState and humanOverride return decisions without finalizing the record', async (t) => {
  const fixture = await golden.fixture(t);
  await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
  writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n');
  const before = await executionReads.loadTicket(fixture);
  const executionRecord = await executionReads.loadTicket(fixture);

  assert.ok(
    await reconcile.dirtyState(executionRecord, { git: fixture.options.deps.git, worktree: fixture.worktree }),
    'the human file is unknown dirty state',
  );
  assert.equal(executionRecord.state, 'active');
  assert.deepEqual(await executionReads.loadTicket(fixture), before, 'the hold is only decided');
  assert.equal((await reconcile.humanOverride(executionRecord, [NEEDS_HUMAN_LABEL], 'gg'))?.next, 'abandon');
  assert.equal(executionRecord.state, 'active');
  assert.deepEqual(await executionReads.loadTicket(fixture), before, 'the abandonment is only decided');
});

test('a vertex missing from the flow holds the ticket', async (t) => {
  const fixture = await golden.fixture(t);
  await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-completion');
  const flow = withoutGreen(fixture);

  const loaded = await executionReads.loadTicket(fixture);
  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, loaded, flow));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason as string, /Vertex green/);

  await interpreter.runExecution({ ...fixture.options, flow, record: await executionReads.loadTicket(fixture) });
  assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
  assert.equal(fixture.harness.calls.length, 2);
});

// A green whose first pass fails the Green Check, so its recovery pass runs and passes.
const testFixFixture = (t: TestContext) =>
  goldenRun.greenFixture(t, {
    responses: {
      'green/1/green/1': goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
      'green/1/recover/1': goldenRun.greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
    },
  });
const greenActions = (fixture: golden.GoldenFixture) =>
  fixture
    .readEvents()
    .filter((event): event is events.ActionEvent => event.type === 'action' && event.vertex === 'green')
    .map((event) => `${event.action}/${event.recovery}`);

test('a resume after the commit of a recovery pass continues at its push', async (t) => {
  const fixture = await testFixFixture(t);
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      crashAt: { marker: golden.markerOf(fixture.executionRecord, 'green', 1, 'commit', 1), point: 'after-completion' },
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  const loaded = await executionReads.loadTicket(fixture);
  assert.deepEqual(
    [loaded.cursor.action, loaded.cursor.recovery],
    ['commit', 1],
    'the commit inherits the recovery pass number',
  );

  const result = await interpreter.runExecution({ ...fixture.options, record: loaded });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.equal(fixture.harness.calls.length, 3, 'no agent call runs again');
  assert.deepEqual(greenActions(fixture), ['green/0', 'test/0', 'green/1', 'test/1', 'commit/1', 'push/1', 'pr/1']);
});

test('a missing transcript starts the phase fresh', async (t) => {
  const fixture = await testFixFixture(t);
  // Before the recovery Attempt's intent: one interrupted after it would be held instead.
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      crashAt: { marker: golden.markerOf(fixture.executionRecord, 'green', 1, 'green', 1), point: 'before-intent' },
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  const loaded = await executionReads.loadTicket(fixture);
  assert.deepEqual([loaded.cursor.action, loaded.cursor.recovery], ['green', 1], 'the recovery pass');
  rmSync(loaded.sessions['green/1/green']?.transcriptPath as string);

  const result = await interpreter.runExecution({ ...fixture.options, record: loaded });
  const call = fixture.harness.calls[2];
  assert.equal(call?.marker, golden.markerOf(loaded, 'green', 1, 'green', 1), 'the recovery pass of the green call');
  assert.equal(call?.resume, null, 'the green Session is not resumed without its transcript');
  assert.ok(call?.brief?.includes(golden.GREEN_FAIL_OUTPUT), 'the full recovery Brief, not a nudge');
  assert.ok(
    fixture.logs.some((line) => /transcript/.test(line)),
    `the fresh start is logged: ${JSON.stringify(fixture.logs)}`,
  );
  assert.equal(result.outcome, 'ready-for-qa');
  // The resume continues at the recovery pass: no first-pass Action runs again, and the Actions after it carry its
  // number.
  assert.deepEqual(greenActions(fixture), ['green/0', 'test/0', 'green/1', 'test/1', 'commit/1', 'push/1', 'pr/1']);
});

test('bounds survive a restart', async (t) => {
  const review = (findings: unknown[]) => ({
    files: {},
    response: {
      claim: 'changes',
      summary: 'The review says changes.',
      definitionOfDoneMet: true,
      redGreenEvidenceOk: true,
      findings,
      diagnosis: '',
    },
  });
  const finding = (issue: string) => ({ severity: 'major', file: 'lib/add.mjs', issue, fix: 'Make it right.' });
  const fixture = await reviewFlow.reviewFixture(
    t,
    {
      'reviewer/1/review/1': review([finding('first problem')]),
      'implementer-fix/1/fix/1': {
        files: { 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' },
        response: { ...golden.greenResponse, summary: 'Address the findings.' },
      },
      'reviewer/2/review/1': review([finding('second problem')]),
    },
    {
      configure: (configured) => {
        (configured.flows.golden.ticket.vertices.reviewer.route as { changes: { max: number } }).changes.max = 1;
      },
    },
  );
  const key = 'reviewer->implementer-fix:changes';
  const { loaded } = await crashResume.crashed(fixture, ['reviewer', 2, 'comment', 0], 'after-completion');
  assert.equal(loaded.traversals[key], 1, 'the Edge is at its Bound');

  const before = fixture.harness.calls.length;
  const result = await interpreter.runExecution({ ...fixture.options, record: loaded });
  assert.equal(result.outcome, 'needs-human', 'the changes Edge routes to its exhausted target');
  assert.ok(
    !fixture.harness.calls.slice(before).some((call) => call.brief?.startsWith('FIX VISIT')),
    'no fix call after the restart',
  );
  const final = await executionReads.loadTicket(fixture);
  assert.equal(final.traversals[key], 1);
  assert.deepEqual(final.visits, { red: 1, green: 1, reviewer: 2, 'implementer-fix': 1 });
});

test('a corrupt record holds the ticket', async (t) => {
  const fixture = await golden.fixture(t);
  const corrupt = '{ "schemaVersion": 1, "log": [';
  const database = sqlite.openDb(fixture.commonDir);
  database.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = ?").run(corrupt, golden.TICKET);
  const err = await executionReads.loadTicket(fixture).catch((thrown: unknown) => thrown);
  assert.ok(err instanceof record.RecordCorruptError, String(err));

  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, err));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason as string, /corrupt/);
  assert.equal(
    caseDatabase.savedJson(fixture.commonDir, 'ticket', golden.TICKET),
    corrupt,
    'the corrupt record is never discarded',
  );
});

// #66: a lookup that fails proves nothing either way. The done comment landed before the crash, so only a working
// lookup can tell.
const badGateway = () =>
  Object.assign(new Error('gh: Bad Gateway (HTTP 502)\ngh api repos/{owner}/{repo}/issues/15/comments'), {
    code: 1,
    stdout: '',
    stderr: 'gh: Bad Gateway (HTTP 502)',
  });
const withDoneMarker = (fixture: golden.GoldenFixture, actionMarker: string) =>
  crashResume.withMarker(
    fixture.gh.comments.map((comment) => comment.body),
    actionMarker,
  );

test('a failed lookup is unknown, not absent', async (t) => {
  const fixture = await golden.fixture(t);
  const { actionMarker, loaded } = await crashResume.crashed(
    fixture,
    crashResume.EFFECTS.comment.place,
    'after-effect',
  );
  const entry = writeAhead.openIntents(loaded).find((open) => open.actionMarker === actionMarker);
  const down = {
    ...fixture.options.deps.gh,
    comments: async () => {
      throw badGateway();
    },
  };

  // Only the context a comment's lookup reads.
  const context = { executionRecord: loaded, gh: down, cwd: fixture.mainRoot } as unknown as Parameters<
    typeof effectEvidence.findEffect
  >[1];
  const found = await effectEvidence.findEffect(entry as writeAhead.WriteAheadEntry, context);
  assert.equal(found.status, 'unknown');
  assert.match((found as { error: Error }).error.message, /HTTP 502/);
  await assert.rejects(
    reconcile.reconcile({ ...crashResume.reconcileOptions(fixture, loaded), gh: down }),
    /HTTP 502/,
    'never taken for absence',
  );
  assert.deepEqual(executionReads.writeAheadSteps(loaded, actionMarker), ['intent'], 'no evidence or completion');
  assert.equal(withDoneMarker(fixture, actionMarker).length, 1);
});

test('a failed lookup in a Run is retried on the Action budget and finds the landed effect', async (t) => {
  const fixture = await golden.fixture(t);
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.comment.place, 'after-effect');
  const failures = { left: 1 };
  const gh = fixture.options.deps.gh;
  const once: typeof gh = {
    ...gh,
    comments: async (...args) => {
      if (failures.left-- > 0) throw badGateway();
      return gh.comments(...args);
    },
  };

  const result = await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, gh: once },
    record: await executionReads.loadTicket(fixture),
  });
  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.equal(withDoneMarker(fixture, actionMarker).length, 1, 'not posted again');
  assert.deepEqual(fixture.sleeps, [60_000]);
  assert.deepEqual(executionReads.writeAheadSteps(await executionReads.loadTicket(fixture), actionMarker), [
    'intent',
    'evidence',
    'complete',
  ]);
});

test('a resumed Visit whose Procedure changed is held', async (t) => {
  const fixture = await golden.fixture(t);
  await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-completion');
  golden.configure(fixture, (configured) => {
    (configured.procedures.implement as unknown as { recover: { max: number } }).recover.max = 2;
  });

  const decided = await reconcile.reconcile(
    crashResume.reconcileOptions(fixture, await executionReads.loadTicket(fixture)),
  );
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason as string, /Procedure implement/);

  await interpreter.runExecution({ ...fixture.options, record: await executionReads.loadTicket(fixture) });
  assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
  assert.equal(fixture.harness.calls.length, 2, 'nothing ran after the hold');
});
