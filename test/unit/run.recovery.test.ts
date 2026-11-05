import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as integrity from '../../lib/integrity.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as admissionHoldEvents from '../support/admission-hold-events.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as failingGit from '../support/failing-git.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
type RunFixture = runFixture.RunFixture;

test('an admission failure on an active execution is reported as a fault', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL] });
  const seeded = await runFixture.crashBeforePush(fixture);
  const adds = failingGit.failGitVerb(fixture, 'ensureWorktree', 'worktree add failed\nfatal: disk full');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
  assert.match(runFixture.ticketResult(results)?.error as string, /disk full/);
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  const final = (await record.load(fixture.commonDir, 'ticket', TICKET)) as record.ExecutionRecord;
  assert.equal(final.state, 'fault', 'the record is marked, so it is not retried');
  assert.equal(final.execution, seeded.execution);
  assert.deepEqual(
    writeAhead.openIntents(final).filter((entry) => entry.effect === 'push'),
    writeAhead.openIntents(seeded),
    'the earlier intent is kept',
  );
  assert.ok(
    fixture.gh.labels.has(NEEDS_HUMAN_LABEL) && !fixture.gh.labels.has(IN_PROGRESS_LABEL),
    'the Ticket is at needs-human',
  );
  assert.ok(
    fixture.comments().some((body) => body.includes('disk full')),
    `a comment carries the error: ${JSON.stringify(fixture.comments())}`,
  );
  const ticketEnd = fixture
    .readEvents()
    .find((event): event is events.TicketEndEvent => event.type === 'ticket_end' && event.ticket === TICKET);
  assert.match(ticketEnd?.error as string, /disk full/);
  assert.ok(
    fixture
      .readEvents()
      .some(
        (event) =>
          event.type === 'ticket_start' &&
          event.run === runFixture.lastRun(fixture) &&
          event.execution === seeded.execution,
      ),
  );

  const second = await run.runTarget(fixture.options);
  assert.equal(adds.count, 1, 'the worktree add is not retried');
  assert.equal(runFixture.ticketResult(second)?.outcome, 'skipped');
});

// The first Run of a dirty Ticket whose hold comment gets HTTP 502: the hold is decided, its comment intent left open.
async function pendingHoldComment(fixture: RunFixture, openEffects: string[], message: string) {
  const first = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  assert.match(runFixture.ticketResult(first)?.error as string, /HTTP 502/);
  const mid = await executionReads.loadTicket(fixture);
  assert.equal(mid?.terminalReason?.decidedBy.hold, 'dirty-worktree', 'the hold is decided durably');
  assert.equal(mid.cursor.vertex, 'needs-human');
  assert.equal(mid.terminalStop?.held, true);
  assert.notEqual(mid.state, 'held', 'a hold whose comment is pending is not held');
  assert.deepEqual(
    writeAhead.openIntents(mid).map((entry) => entry.effect),
    openEffects,
    message,
  );
  return mid;
}

// The next Run lands the hold with one comment carrying the original Action Marker.
async function landedHoldComment(fixture: RunFixture, mid: record.ExecutionRecord) {
  const second = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const final = await executionReads.loadTicket(fixture);
  const [open] = writeAhead.openIntents(mid).filter((entry) => entry.effect === 'comment');
  assert.equal(final.execution, mid.execution);
  assert.equal(final.state, 'held');
  assert.equal(fixture.comments().length, 1, 'exactly one hold comment');
  assert.ok(
    fixture.comments()[0]?.includes(marker.markerComment(open?.actionMarker as string)),
    'the comment carries the original Action Marker',
  );
  assert.ok(
    fixture.gh.labels.has(NEEDS_HUMAN_LABEL) && !fixture.gh.labels.has(IN_PROGRESS_LABEL),
    `the hold labels land: ${[...fixture.gh.labels]}`,
  );
  return final;
}

// The hold has one ticket_end, written by the latest Run with the Terminal Reason decided in the first.
async function assertHoldEndedInLastRun(
  fixture: RunFixture,
  final: record.ExecutionRecord,
  mid: record.ExecutionRecord,
) {
  const ends = runFixture.endsOf(fixture, final.execution);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0]?.terminalReason, mid.terminalReason);
  assert.equal(ends[0]?.run, runFixture.lastRun(fixture));
}

// The worktree, its HEAD and the remote branch are as before, and no PR was read or published.
async function assertNothingPublished(fixture: RunFixture, before: integrity.WorktreeSnapshot, head: string | null) {
  assert.deepEqual(
    await integrity.snapshot(fixture.worktree, fixture.options.deps.git),
    before,
    'the worktree is untouched',
  );
  assert.equal(await fixture.options.deps.git.headSha(fixture.worktree), head, 'nothing was committed or reset');
  assert.equal(
    fixture.gh.calls.some((call) => call.args[0] === 'pr'),
    false,
    'no PR was read or published',
  );
  assert.equal(await fixture.options.deps.git.remoteSha(fixture.mainRoot, BRANCH), null, 'nothing was pushed');
}

test('a dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const before = await integrity.snapshot(fixture.worktree, fixture.options.deps.git);
  const head = await fixture.options.deps.git.headSha(fixture.worktree);
  const failing = runFixture.failComment(fixture);

  const mid = await pendingHoldComment(fixture, ['comment'], 'only the hold comment intent stays open');
  assert.deepEqual(fixture.comments(), []);
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0, 'the hold has not landed');
  assert.equal(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), false);
  assert.equal(fixture.gh.labels.has(IN_PROGRESS_LABEL), false);

  failing.on = false;
  const final = await landedHoldComment(fixture, mid);
  assert.deepEqual(writeAhead.openIntents(final), []);
  await assertHoldEndedInLastRun(fixture, final, mid);
  assert.equal(fixture.harness.calls.length, 0, 'no agent ran');
  await assertNothingPublished(fixture, before, head);
});

test('a seeded dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  const { runFixture: fixture, seededRecord } = await runFixture.dirtyTicket(t, true);
  const seeded = seededRecord as record.ExecutionRecord;
  const before = await integrity.snapshot(fixture.worktree, fixture.options.deps.git);
  const head = await fixture.options.deps.git.headSha(fixture.worktree);
  const failing = runFixture.failComment(fixture);

  const mid = await pendingHoldComment(
    fixture,
    ['commit', 'comment'],
    'the hold comment intent stays open beside the seeded commit',
  );
  assert.deepEqual(
    writeAhead.openIntents(mid).filter((entry) => entry.effect === 'commit'),
    writeAhead.openIntents(seeded),
    'older intents are unchanged',
  );
  assert.deepEqual(fixture.comments(), []);
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0, 'the hold has not landed');
  assert.equal(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), false);
  assert.equal(
    fixture.gh.labels.has(IN_PROGRESS_LABEL),
    true,
    'a seeded in-progress label is kept until the hold lands',
  );

  failing.on = false;
  const final = await landedHoldComment(fixture, mid);
  assert.deepEqual(writeAhead.openIntents(final), writeAhead.openIntents(seeded), 'only the seeded commit stays open');
  await assertHoldEndedInLastRun(fixture, final, mid);
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  await assertNothingPublished(fixture, before, head);
});

test('a resumed pending report emits no second ticket_start', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const failing = runFixture.failComment(fixture);
  const first = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  failing.on = false;

  const second = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const { execution } = await executionReads.loadTicket(fixture);
  assert.equal(
    fixture.readEvents().filter((event) => event.type === 'ticket_start' && event.execution === execution).length,
    1,
  );
  assert.equal(runFixture.endsOf(fixture, execution).length, 1);
});

// A pending hold comment whose worktree the human fixed before the next Run, which still finishes the hold.
async function fixedWhileHoldPending(fixture: RunFixture, agentCalls: number, message: string) {
  const failing = runFixture.failComment(fixture);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  const mid = await executionReads.loadTicket(fixture);
  failing.on = false;
  rmSync(join(fixture.worktree, 'human.txt'));

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2, 'the pending hold finishes, not the Ticket');
  const held = await executionReads.loadTicket(fixture);
  assert.equal(held.execution, mid?.execution);
  assert.equal(held.state, 'held');
  assert.equal(fixture.comments().length, 1);
  assert.equal(runFixture.endsOf(fixture, held.execution).length, 1);
  assert.equal(fixture.harness.calls.length, agentCalls, message);
  return mid;
}

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('fixing the worktree while a hold comment is pending still finishes the hold, and a fresh hold restarts', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const mid = await fixedWhileHoldPending(fixture, 0, 'no agent ran');

  fixture.gh.labels.delete(NEEDS_HUMAN_LABEL);
  const third = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(third), 0, JSON.stringify(third));
  assert.notEqual(
    (await executionReads.loadTicket(fixture)).execution,
    mid.execution,
    'a fresh hold restarts as a new Execution',
  );
  assert.equal(fixture.harness.calls.length, 2);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('fixing the worktree while a hold comment is pending still finishes the hold, and a seeded hold stays held', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, true);
  await fixedWhileHoldPending(fixture, 2, 'no agent call beyond the seeded 2');

  fixture.gh.labels.delete(NEEDS_HUMAN_LABEL);
  const third = await run.runTarget(fixture.options);
  assert.equal(
    runFixture.ticketResult(third)?.outcome,
    'skipped',
    'a held Execution with Visits needs its row deleted',
  );
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('a landed hold comment with a lost response is not posted twice', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  runFixture.failComment(fixture, { lost: true });
  // The retry looks for the comment by its marker first, so the hold lands within the Run.
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  assert.equal(fixture.comments().length, 1, 'the marker found it, so it was not posted again');
  assert.equal(fixture.gh.calls.filter((call) => fakeGh.isCommentPost(call.args)).length, 1);
  const final = await executionReads.loadTicket(fixture);
  const comment = final.writeAheadLog.find((entry) => entry.step === 'intent' && entry.effect === 'comment');
  const ofComment = final.writeAheadLog.filter((entry) => entry.actionMarker === comment?.actionMarker);
  assert.deepEqual(
    ofComment.map((entry) => entry.step),
    ['intent', 'evidence', 'complete'],
  );
  assert.equal(ofComment.find((entry) => entry.step === 'evidence')?.evidence?.id, fixture.gh.comments[0]?.id);
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the label lands');
  assert.equal(final.state, 'held');
});

test('an ensureWorktree failure without a record is marked and never retried', async (t) => {
  const fixture = runFixture.fixture(t);
  const adds = failingGit.failGitVerb(fixture, 'ensureWorktree', 'worktree add failed\nfatal: disk full');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1);
  assert.match(runFixture.ticketResult(results)?.error as string, /disk full/);
  const executionRecord = await executionReads.loadTicket(fixture);
  assert.equal(executionRecord?.state, 'fault', 'the fault is marked on a record created for it');
  assert.equal(executionRecord.branch, BRANCH);
  assert.equal(executionRecord.worktree, fixture.worktree);
  assert.ok(
    fixture.comments().some((body) => body.includes('disk full')),
    JSON.stringify(fixture.comments()),
  );
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
  assert.ok(!fixture.labelAdds().includes(IN_PROGRESS_LABEL), 'in-progress is never set');
  const ticketEvents = fixture.readEvents().filter((event) => 'ticket' in event && event.ticket === TICKET);
  assert.deepEqual(
    ticketEvents.map((event) => (event.type === 'action' ? `${event.action} ${event.recovery}` : event.type)),
    ['ticket_start', 'fault-comment 0', 'fault-label 0', 'ticket_end'],
  );
  assert.ok(ticketEvents.every((event) => 'execution' in event && event.execution === executionRecord.execution));
  assert.match((ticketEvents.at(-1) as events.TicketEndEvent).error as string, /disk full/);
  assert.equal(fixture.harness.calls.length, 0);

  const second = await run.runTarget(fixture.options);
  assert.equal(adds.count, 1, 'the worktree add is never retried');
  assert.equal(runFixture.ticketResult(second)?.outcome, 'skipped');
  assert.equal(run.runExitCode(second), 2);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('admission holds emit ticket lifecycle events with their Terminal Reason: a record on another branch', async (t) => {
  const fixture = runFixture.fixture(t);
  await record.save(unvisitedExecution.unvisitedExecution(fixture, { run: 'seed', branch: 'ticket/99-other' }));

  await admissionHoldEvents.assertAdmissionHoldEvents(fixture, await run.runTarget(fixture.options), 'branch-mismatch');
});
