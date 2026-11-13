import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as locks from '../../lib/locks.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as golden from '../support/golden.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as failingGit from '../support/failing-git.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as resetInterruption from '../support/reset-interruption.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
type RunFixture = runFixture.RunFixture;

const labelFailed = (fixture: RunFixture) =>
  fixture.readEvents().some((event) => event.type === 'label_failed' && event.ticket === TICKET);
// gg's needs-human label, with in-progress gone.
const heldLabels = (fixture: RunFixture) =>
  fixture.gh.labels.has(NEEDS_HUMAN_LABEL) && !fixture.gh.labels.has(IN_PROGRESS_LABEL);

// The first Run of a dirty Ticket whose hold label fails: the hold is decided, its label intent left open.
async function failedHoldLabel(fixture: RunFixture, openEffects: string[], message: string) {
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  assert.equal(fixture.comments().length, 1);
  assert.ok(labelFailed(fixture), 'the label failure is an Event');
  const mid = executionReads.loadTicket(fixture);
  assert.equal(mid?.terminalStop?.held, true, 'the hold is decided');
  assert.notEqual(mid.state, 'held', 'a hold whose label is pending is not held');
  assert.deepEqual(
    writeAhead.openIntents(mid).map((entry) => entry.effect),
    openEffects,
    message,
  );
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0);
  return mid;
}

// The next Run, with the label working again: the hold lands, reusing its comment.
async function landedHold(fixture: RunFixture, mid: record.ExecutionRecord) {
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  assert.equal(fixture.comments().length, 1, 'the landed comment is reused');
  assert.ok(heldLabels(fixture), `the hold labels land: ${[...fixture.gh.labels]}`);
  const final = executionReads.loadTicket(fixture);
  assert.equal(final.execution, mid.execution);
  return final;
}

test('an admission hold of a fresh Ticket names no Visit (#341)', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  await run.runTarget(fixture.options);
  const { terminalReason } = record.load(fixture.commonDir, 'ticket', runFixture.TICKET)!;
  assert.deepEqual(terminalReason!.decidedBy, { hold: 'dirty-worktree' });
});

test('a hold label failure leaves its label intent open for the next Run', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const failing = runFixture.failHoldLabel(fixture);
  const mid = await failedHoldLabel(fixture, ['label'], 'the label intent stays open');

  failing.on = false;
  const final = await landedHold(fixture, mid);
  assert.deepEqual(writeAhead.openIntents(final), []);
  assert.equal(final.state, 'held');
  assert.equal(runFixture.endsOf(fixture, final.execution).length, 1);
});

test('a seeded hold label failure is finished on the next Run', async (t) => {
  const { runFixture: fixture, seededRecord } = await runFixture.dirtyTicket(t, true);
  const failing = runFixture.failHoldLabel(fixture);
  const mid = await failedHoldLabel(
    fixture,
    ['commit', 'label'],
    'the label intent stays open beside the seeded commit',
  );

  failing.on = false;
  const final = await landedHold(fixture, mid);
  assert.deepEqual(
    writeAhead.openIntents(final),
    writeAhead.openIntents(seededRecord as record.ExecutionRecord),
    'only the seeded commit stays open',
  );
  assert.equal(final.state, 'held');
  assert.equal(runFixture.endsOf(fixture, final.execution).length, 1);
});

// A seeded dirty Ticket whose hold comment failed, under a human needs-human label, with every label edit recording
// whether the record was abandoned first and failing while `cleanup.fails` is set.
async function overriddenPendingHold(t: TestContext) {
  const { runFixture: fixture, seededRecord } = await runFixture.dirtyTicket(t, true);
  const before = await integrity.snapshot(fixture.worktree, fixture.options.deps.git);
  const failing = runFixture.failComment(fixture);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  const mid = executionReads.loadTicket(fixture);
  const [holdComment] = writeAhead.openIntents(mid).filter((entry) => entry.effect === 'comment');
  failing.on = false;
  fixture.gh.labels.add(NEEDS_HUMAN_LABEL);
  const states: (boolean | undefined)[] = [];
  const cleanup = { fails: false };
  const transport = fakeGh.ghThrough(fixture.gh, async (call, next) => {
    const [noun, verb, number] = call.args;
    if (noun === 'issue' && verb === 'edit') {
      states.push(executionReads.loadTicket(fixture).terminalStop?.abandoned);
      if (cleanup.fails) {
        fixture.gh.calls.push(call);
        throw new Error(`gh issue edit ${number} exited 1\nHTTP 502: Bad Gateway`);
      }
    }
    return next();
  });
  fixture.options.deps.gh = github.createGh(transport);
  return { fixture, seededRecord: seededRecord as record.ExecutionRecord, before, mid, holdComment, states, cleanup };
}
type OverriddenHold = Awaited<ReturnType<typeof overriddenPendingHold>>;

// The override landed: abandoned under the human's label, its hold comment never replayed, the worktree untouched.
async function assertOverrideLanded({ fixture, seededRecord, before, holdComment }: OverriddenHold) {
  assert.deepEqual(fixture.comments(), [], 'the pending hold comment is not replayed');
  assert.deepEqual(fixture.labelAdds(), [], 'no label is added');
  assert.ok(heldLabels(fixture), `the human hold remains: ${[...fixture.gh.labels]}`);
  const final = executionReads.loadTicket(fixture);
  assert.equal(final.state, 'abandoned');
  assert.match(final.terminalReason?.text as string, /needs-human/);
  const ends = runFixture.endsOf(fixture, final.execution);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.outcome, 'abandoned');
  assert.deepEqual(ends[0]?.terminalReason, final.terminalReason);
  assert.ok(
    writeAhead.openIntents(final).some((entry) => entry.actionMarker === holdComment?.actionMarker),
    'the hold comment intent stays open, never replayed',
  );
  assert.deepEqual(
    writeAhead.openIntents(final).filter((entry) => entry.effect === 'commit'),
    writeAhead.openIntents(seededRecord),
    'the older intent is kept',
  );
  assert.deepEqual(
    final.writeAheadLog
      .filter((entry) => entry.step === 'intent' && entry.effect === 'label')
      .map((entry) => entry.payload),
    [{ ticket: TICKET, add: [], remove: [IN_PROGRESS_LABEL] }],
    'the cleanup is one write-ahead label Action',
  );
  assert.deepEqual(
    await integrity.snapshot(fixture.worktree, fixture.options.deps.git),
    before,
    'the worktree is untouched',
  );
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
}

test('human override abandons a pending hold before any label cleanup', async (t) => {
  const overridden = await overriddenPendingHold(t);

  const results = await run.runTarget(overridden.fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.outcome, 'abandoned');
  assert.deepEqual(overridden.states, [true], 'abandoned before the label cleanup');
  await assertOverrideLanded(overridden);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('human override of a pending hold is decided durably when its label cleanup fails, and lands on the next Run', async (t) => {
  const overridden = await overriddenPendingHold(t);
  const { fixture, mid, cleanup } = overridden;
  cleanup.fails = true;

  const failed = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(failed), 1, JSON.stringify(failed));
  const pending = executionReads.loadTicket(fixture);
  assert.equal(pending.terminalStop?.abandoned, true, 'the abandonment is decided durably');
  assert.equal(pending.state, 'active', 'its final state lands with ticket_end');
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0, 'the abandonment has not landed');

  cleanup.fails = false;
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.outcome, 'abandoned');
  assert.deepEqual(overridden.states, [true, true], 'abandoned before every label cleanup');
  await assertOverrideLanded(overridden);
});

test('a pending fault report whose comment lookup fails stays pending and posts no second comment', async (t) => {
  const fixture = runFixture.fixture(t);
  failingGit.failGitVerb(fixture, 'ensureWorktree', 'worktree add failed\nfatal: disk full');
  const failing = { mode: 'crash' as 'crash' | 'lookup' | null };
  const transport = fakeGh.ghThrough(fixture.gh, async (call, next) => {
    if (failing.mode === 'crash' && fakeGh.isCommentPost(call.args)) {
      await next();
      throw new interpreter.CrashError('crash after the fault comment landed');
    }
    if (
      failing.mode === 'lookup' &&
      call.args[0] === 'api' &&
      /issues\/\d+\/comments$/.test(call.args.at(-1) as string)
    ) {
      fixture.gh.calls.push(call);
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    }
    return next();
  });
  fixture.options.deps.gh = github.createGh(transport);

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  const mid = executionReads.loadTicket(fixture);
  const [open] = writeAhead.openIntents(mid ?? { writeAheadLog: [] }).filter((entry) => entry.effect === 'comment');
  assert.ok(open, 'the landed fault comment waits for its completion');
  assert.equal(fixture.comments().length, 1);

  failing.mode = 'lookup';
  const second = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(second), 1, JSON.stringify(second));
  assert.match(runFixture.ticketResult(second)?.error as string, /HTTP 502/);
  assert.equal(fixture.comments().length, 1, 'the stored payload is not posted again');
  const still = executionReads.loadTicket(fixture);
  assert.deepEqual(still.terminalReason, mid.terminalReason, 'the fault keeps its Terminal Reason');
  assert.deepEqual(still.terminalStop, mid.terminalStop);
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0, 'the fault stays pending');

  failing.mode = null;
  const third = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(third), 1, 'a fault exits 1');
  assert.equal(fixture.comments().length, 1, 'the marker found the landed comment');
  const final = executionReads.loadTicket(fixture);
  assert.deepEqual(
    final.writeAheadLog.filter((entry) => entry.actionMarker === open.actionMarker).map((entry) => entry.step),
    ['intent', 'evidence', 'complete'],
  );
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the label lands');
  assert.equal(final.state, 'fault');
  assert.equal(runFixture.endsOf(fixture, final.execution).length, 1);
  assert.match(runFixture.endsOf(fixture, final.execution)[0]?.error as string, /disk full/);
});

test('a Terminal saved before ticket_end resumes finalization exactly once', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const restore = caseDatabase.failAppends(t, (event) => event.type === 'ticket_end');
  const first = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = executionReads.loadTicket(fixture);
  assert.equal(mid?.state, 'active', 'the final state rolled back with its ticket_end');
  assert.equal(mid.terminalStop?.held, true, 'the decided hold waits for the next Run');
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 0);
  restore();
  const effects = () =>
    fixture.gh.calls.filter(
      (call) => fakeGh.isCommentPost(call.args) || (call.args[0] === 'issue' && call.args[1] === 'edit'),
    ).length;
  const done = effects();

  const second = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(second), 2);
  assert.equal(runFixture.ticketResult(second)?.outcome, 'needs-human', 'not skipped as finished');
  assert.equal(effects(), done, 'no GitHub effect is repeated');
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 1);
  assert.equal(fixture.comments().length, 1);
});

test('a crash between admission and its hold keeps the decision and its one ticket_start', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  // Every update carrying a Terminal stop fails, as if gg died once admission had saved the new record.
  const restore = caseDatabase.failSaves(
    t,
    (saved, next) => saved !== undefined && (next as record.ExecutionRecord).terminalStop != null,
  );
  const first = await run.runTarget(fixture.options);
  restore();
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = executionReads.loadTicket(fixture);
  assert.ok(mid, 'admission saved the record');
  assert.equal(mid.terminalStop, null, 'the hold was never saved');
  assert.equal(fixture.comments().length, 0);

  const second = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const starts = fixture
    .readEvents()
    .filter((event): event is events.TicketStartEvent => event.type === 'ticket_start' && event.ticket === TICKET);
  assert.deepEqual(
    starts.map((event) => event.execution),
    [mid.execution],
    'one ticket_start for the Execution',
  );
  const final = executionReads.loadTicket(fixture);
  assert.equal(final.state, 'held');
  assert.equal(final.terminalStop?.fresh, true, 'the hold is still the fresh one admission decided');
  const [comment, ...more] = fixture.comments();
  assert.equal(more.length, 0);
  assert.doesNotMatch(comment as string, /DELETE FROM records/, 'a fresh hold has no row to delete');
  assert.equal(runFixture.endsOf(fixture, mid.execution).length, 1);
});

test('an Interrupted Attempt hold warns before its record is deleted, then and on the next Run', async (t) => {
  const responses = {
    ...golden.firstVisitResponses,
    'red/1/red/1': { throw: new interpreter.CrashError('gg died during the call') },
  };
  const fixture = runFixture.fixture(t, { responses, labels: [IN_PROGRESS_LABEL] });
  await runFixture.seedExecution(fixture);
  const warning = /including ignored Protected Files\. Check them[^]*before deleting the record/;

  const first = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(first), 2, JSON.stringify(first));
  assert.equal(executionReads.loadTicket(fixture).state, 'held');
  assert.match(fixture.comments().at(-1) ?? '', warning, 'the hold comment warns');

  await run.runTarget(fixture.options);
  const skipped = fixture.logs.findLast((line) => line.includes('skipped')) ?? '';
  assert.match(skipped, warning, 'the held-record skip warns too');
  assert.ok(
    skipped.search(warning) < skipped.indexOf('DELETE FROM records'),
    `the warning comes before the delete: ${skipped}`,
  );
});

// An Execution saved before its first Visit, under a human needs-human label.
async function overriddenBeforeFirstVisit(t: TestContext) {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL] });
  const { mainRoot, worktree } = fixture;
  await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  record.save(unvisitedExecution.unvisitedExecution(fixture));
  return fixture;
}

// The Run under the human's label abandoned the Execution and only removed in-progress, leaving the worktree as it was.
async function assertAbandonedBeforeFirstVisit(fixture: RunFixture, before: integrity.WorktreeSnapshot) {
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'abandoned', JSON.stringify(results));
  assert.equal(run.runExitCode(results), 2, 'a human needs-human label exits 2');
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
      ['issue', 'edit'],
    ],
    'only the in-progress label is removed',
  );
  assert.deepEqual([...fixture.gh.labels], [NEEDS_HUMAN_LABEL], 'the human hold remains without in-progress');
  assert.deepEqual(
    await integrity.snapshot(fixture.worktree, fixture.options.deps.git),
    before,
    'the worktree is untouched',
  );
  const final = executionReads.loadTicket(fixture);
  assert.equal(final.state, 'abandoned', 'the label overrides the record before any Visit');
  assert.deepEqual(Object.fromEntries(final.visits), {});
  assert.deepEqual(
    final.writeAheadLog.map((entry) => `${entry.step} ${entry.effect}`),
    ['intent label', 'evidence label', 'complete label'],
    'the cleanup is one write-ahead Action',
  );
  assert.deepEqual(final.writeAheadLog[0]?.payload, { ticket: TICKET, add: [], remove: [IN_PROGRESS_LABEL] });
  const ticketEvents = fixture.readEvents().filter((event) => 'ticket' in event && event.ticket === TICKET);
  assert.deepEqual(
    ticketEvents.map((event) => event.type),
    ['ticket_start', 'action', 'ticket_end'],
  );
  const ticketEnd = ticketEvents.at(-1) as events.TicketEndEvent;
  assert.equal(ticketEnd.outcome, 'abandoned');
  assert.deepEqual(ticketEnd.terminalReason, final.terminalReason);
}

test('a human needs-human label before the first Visit prevents admission effects', async (t) => {
  const fixture = await overriddenBeforeFirstVisit(t);
  const before = await integrity.snapshot(fixture.worktree, fixture.options.deps.git);

  await assertAbandonedBeforeFirstVisit(fixture, before);
});

test('a human needs-human label before the first Visit prevents admission effects in a dirty worktree', async (t) => {
  const fixture = await overriddenBeforeFirstVisit(t);
  writeFileSync(join(fixture.worktree, 'human.txt'), 'mine\n');
  const before = await integrity.snapshot(fixture.worktree, fixture.options.deps.git);

  await assertAbandonedBeforeFirstVisit(fixture, before);
  assert.equal(readFileSync(join(fixture.worktree, 'human.txt'), 'utf8'), 'mine\n');
});

// A Run that wrote nothing: no agent, no label write or comment, no worktree, and the record row as `row`.
function assertNoAdmissionEffect(fixture: RunFixture, row: string | undefined) {
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
    'no label write or comment',
  );
  assert.equal(fixture.worktrees(), 1, 'no worktree created');
  assert.equal(fixture.loadRow(), row, row === undefined ? 'no record is written' : 'the record is untouched');
}
const corruptRecord = (fixture: RunFixture) =>
  stateDatabase
    .open(fixture.commonDir)
    .prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)")
    .run(TICKET, '{');

test('a human needs-human label prevents admission effects without a record', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [NEEDS_HUMAN_LABEL] });

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2, 'needs-human exits 2 without a record');
  assertNoAdmissionEffect(fixture, undefined);
});

test('a human needs-human label prevents admission effects with a corrupt record', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [NEEDS_HUMAN_LABEL] });
  corruptRecord(fixture);

  assert.equal(
    run.runExitCode(await run.runTarget(fixture.options)),
    2,
    'needs-human exits 2 even without a readable record',
  );
  assertNoAdmissionEffect(fixture, '{');
});

// GitHub matches label names case-insensitively, so a human's own spelling of a State Label is still that label.
const HUMAN_NEEDS_HUMAN = 'GG:State:Needs-Human';
const SHOUTED_IN_PROGRESS = 'GG:STATE:IN-PROGRESS';

const MIXED_CASE = [
  { labels: [HUMAN_NEEDS_HUMAN, SHOUTED_IN_PROGRESS], edits: [['--remove-label', IN_PROGRESS_LABEL]], states: [true] },
  { labels: [HUMAN_NEEDS_HUMAN, IN_PROGRESS_LABEL], edits: [['--remove-label', IN_PROGRESS_LABEL]], states: [true] },
  { labels: [HUMAN_NEEDS_HUMAN], edits: [], states: [] },
];
for (const { labels, edits, states: expectedStates } of MIXED_CASE) {
  test(`mixed-case human needs-human wins before any label write: ${labels.join(', ')}`, async (t) => {
    const fixture = runFixture.fixture(t, { labels });
    const { mainRoot, worktree } = fixture;
    await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
    record.save(unvisitedExecution.unvisitedExecution(fixture));
    const states: (boolean | undefined)[] = [];
    runFixture.hookGh(fixture, async (args) => {
      if (args[0] === 'issue' && args[1] === 'edit')
        states.push(executionReads.loadTicket(fixture).terminalStop?.abandoned);
    });

    const results = await run.runTarget(fixture.options);
    assert.equal(runFixture.ticketResult(results)?.outcome, 'abandoned', JSON.stringify(results));
    assert.equal(run.runExitCode(results), 2);
    assert.equal(fixture.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(
      fixture.gh.calls
        .filter((call) => call.args[0] === 'issue' && call.args[1] === 'edit')
        .map((call) => call.args.slice(3)),
      edits,
      'only the in-progress label is removed',
    );
    assert.deepEqual(states, expectedStates, 'the record is abandoned before the label write');
    assert.deepEqual(fixture.comments(), [], 'no comment posted');
    assert.deepEqual([...fixture.gh.labels], [HUMAN_NEEDS_HUMAN], 'the human hold keeps its spelling');
    assert.equal(executionReads.loadTicket(fixture).state, 'abandoned');
  });
}

// A Run under the human's spelling of needs-human skips the Ticket, which it reports at needs-human.
function assertSkippedAtNeedsHuman(results: run.TicketResult[]) {
  assert.equal(runFixture.ticketResult(results)?.outcome, 'skipped', JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.state, 'needs-human');
  assert.equal(run.runExitCode(results), 2);
}

test('mixed-case needs-human skips without a record', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  assertSkippedAtNeedsHuman(await run.runTarget(fixture.options));
  assertNoAdmissionEffect(fixture, undefined);
});

test('mixed-case needs-human skips with a corrupt record', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  corruptRecord(fixture);
  assertSkippedAtNeedsHuman(await run.runTarget(fixture.options));
  assertNoAdmissionEffect(fixture, '{');
});

test('mixed-case needs-human skips with a held ticket lock', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  // Another connection holds the lock, as another gg process would.
  const holder = await locks.tryAcquire(fixture.commonDir, `ticket-${TICKET}`);
  const results = await run.runTarget(fixture.options).finally(() => locks.release(holder as locks.LockHandle));
  assertSkippedAtNeedsHuman(results);
  assertNoAdmissionEffect(fixture, undefined);
});

test('admission does not re-add differently cased in-progress', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  fixture.options.config.repository.labelPrefix = 'Gg';
  await runFixture.crashBeforePush(fixture);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 2, 'the Execution resumes at its cursor');
  assert.equal(executionReads.loadTicket(fixture).state, 'ready-for-qa');
  assert.deepEqual(fixture.labelAdds(), ['Gg:state:ready-for-qa'], 'in-progress is not added again');
  assert.ok(
    ![...fixture.gh.labels].some((label) => label.toLowerCase() === IN_PROGRESS_LABEL),
    `the Terminal removes it: ${[...fixture.gh.labels]}`,
  );
});

test('a differently cased in-progress without a record is left for Stuck handling', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  fixture.options.config.repository.labelPrefix = 'Gg';
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
  assert.ok(
    fixture.logs.some((line) => line.includes('with no Execution Record behind it')),
    JSON.stringify(fixture.logs),
  );
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
    'no write on a Stuck Ticket',
  );
  assert.equal(fixture.worktrees(), 1, 'no worktree');
  assert.ok(fixture.gh.labels.has(SHOUTED_IN_PROGRESS), 'the State Label is left for Stuck handling');
});

test('an interrupted reset under a human needs-human label is abandoned before anything is discarded', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [NEEDS_HUMAN_LABEL] });
  // red's Attempt breaks an Integrity Assertion, and gg dies before its reset.
  const violating = {
    ...(fixture.options.deps.integrity as integrity.Integrity),
    findViolations: async () => ({
      violations: [
        { worktree: fixture.worktree, surface: 'head', before: null, after: 'a'.repeat(40) },
      ] as unknown as integrity.IntegrityViolation[],
    }),
  };
  const git = resetInterruption.crashingReset(fixture.options.deps.git);
  await runFixture.seedExecution(fixture, { git, integrity: violating });

  await run.runTarget(fixture.options);
  assert.ok(existsSync(join(fixture.worktree, 'test', 'add.test.mjs')), "the agent's changes are kept for the human");
  assert.equal(record.load(fixture.commonDir, 'ticket', TICKET)?.state, 'abandoned', 'the label overrides the record');
  assert.deepEqual(fixture.labelAdds(), [], 'no label written');
  assert.deepEqual(fixture.comments(), [], 'no comment posted');
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded red');
});

const NOT_READY = [{ blockedBy: [{ number: 3, state: 'OPEN' }] }, { state: 'CLOSED' }];
for (const issue of NOT_READY) {
  test(`a resumed execution still needs its ticket open and unblocked: ${JSON.stringify(issue)}`, async (t) => {
    const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL], issue });
    await runFixture.crashBeforePush(fixture);
    const row = fixture.loadRow();
    await run.runTarget(fixture.options);
    assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
    assert.equal(fixture.loadRow(), row, 'the record is not resumed');
    assert.ok(
      fixture.logs.some((line) => line.includes(`#${TICKET}`) && /not ready/.test(line)),
      `the skip is logged: ${JSON.stringify(fixture.logs)}`,
    );
  });
}

// What admission's hold says of a rescue's ref. The intent names a commit, and the hold names the ref only when git
// shows the ref holds it.
async function heldWithRescue(t: TestContext, makeRef: (head: string) => string | null) {
  const { runFixture: fixture, seededRecord } = await runFixture.dirtyTicket(t, true);
  const { git, database } = fixture.options.deps;
  const head = await git.headSha(fixture.worktree);
  const ref = 'refs/gg/rescue/abc';
  const held = makeRef(head);
  if (held) await git.createRef(fixture.worktree, ref, held);
  const left = { head: 'a'.repeat(40), index: 'b'.repeat(40), tree: 'c'.repeat(40) };
  database!.intent(seededRecord!, 'gg:rescue', 'rescue', {
    ref,
    commit: head,
    tree: left.tree,
    parent: head,
    left,
  });
  await run.runTarget(fixture.options);
  const { terminalReason } = record.load(fixture.commonDir, 'ticket', runFixture.TICKET)!;
  // The resumed record was at green's commit, so the hold names that Visit and Action (#341).
  assert.deepEqual(terminalReason!.decidedBy, {
    hold: 'dirty-worktree',
    vertex: 'green',
    visit: 1,
    action: 'commit',
    recovery: 0,
  });
  return terminalReason!.text;
}

test('a dirty worktree hold names the Rescue Ref holding the commit its rescue intended', async (t) => {
  assert.match(await heldWithRescue(t, (head) => head), /Rescue Ref refs\/gg\/rescue\/abc keeps the work/);
});

test('a dirty worktree hold names no Rescue Ref that holds another commit', async (t) => {
  assert.doesNotMatch(await heldWithRescue(t, () => 'e'.repeat(40)), /Rescue Ref/);
});

test('a dirty worktree hold names no Rescue Ref when its rescue never made the ref', async (t) => {
  assert.doesNotMatch(await heldWithRescue(t, () => null), /Rescue Ref/);
});
