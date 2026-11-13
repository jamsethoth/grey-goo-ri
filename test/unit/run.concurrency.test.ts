import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as integrity from '../../lib/integrity.ts';
import * as locks from '../../lib/locks.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as epicRun from '../support/epic-run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as latch from '../support/latch.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as fakeGh from '../support/fake-gh.ts';

const { TICKET } = runFixture;
const { EPIC } = epicRun;
type RunFixture = runFixture.RunFixture;

const outcomes = (results: { ticket: number; outcome: string }[]) =>
  results.map((result) => [result.ticket, result.outcome]);
// A sub-issue of the epic that the Run left alone: no record, worktree, label edit or Event.
async function assertNotAdmitted(fixture: RunFixture, ticket: number, message: string) {
  assert.equal(record.load(fixture.commonDir, 'ticket', ticket), null, message);
  assert.equal(existsSync(epicRun.worktreeOf(fixture, ticket)), false, 'nor a worktree');
  assert.ok(
    !fixture.gh.calls.some(
      (call) => call.args[0] === 'issue' && call.args[1] === 'edit' && call.args[2] === String(ticket),
    ),
    'nor a label edit',
  );
  assert.ok(!fixture.readEvents().some((event) => 'ticket' in event && event.ticket === ticket), 'nor a Ticket Event');
}

test('a held ticket lock skips the ticket', async (t) => {
  const fixture = runFixture.fixture(t);
  // Another connection holds the lock, as another gg process would.
  const holder = (await locks.tryAcquire(fixture.commonDir, `ticket-${TICKET}`)) as locks.LockHandle;
  // Released before the fixture's cleanup, which Windows refuses while the holder keeps the lock file open.
  await run.runTarget(fixture.options).finally(() => locks.release(holder));
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(
    fixture.logs.some((line) => line.includes(`#${TICKET}`) && /lock/.test(line)),
    `the skip is logged: ${JSON.stringify(fixture.logs)}`,
  );
  assert.deepEqual(fixture.labelAdds(), [], 'no label written');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
    'no repository label setup on a held lock',
  );
  assert.equal(fixture.worktrees(), 1, 'no worktree');
});

test('in-progress is set only after the worktree exists', async (t) => {
  const fixture = runFixture.fixture(t);
  // A plain directory where the worktree belongs makes ensureWorktree fail.
  mkdirSync(fixture.worktree, { recursive: true });
  writeFileSync(join(fixture.worktree, 'stray.txt'), 'not a worktree\n');
  await run.runTarget(fixture.options).catch(() => {});
  assert.ok(
    !fixture.labelAdds().includes(executionContext.IN_PROGRESS_LABEL),
    `in-progress was never added: ${JSON.stringify(fixture.labelAdds())}`,
  );
  assert.ok(!fixture.gh.labels.has(executionContext.IN_PROGRESS_LABEL));
  assert.equal(fixture.harness.calls.length, 0);
});

test('a failed label update reaches the log, the event and the exit code', async (t) => {
  const fixture = runFixture.fixture(t, { failEdit: true });
  const results = await run.runTarget(fixture.options);
  assert.ok(
    fixture.logs.some((line) => line.includes(`#${TICKET}`) && line.includes('HTTP 502')),
    `log names the ticket and the error: ${JSON.stringify(fixture.logs)}`,
  );
  assert.ok(
    fixture
      .readEvents()
      .some((event) => event.type === 'label_failed' && event.ticket === TICKET && event.error.includes('HTTP 502')),
    'event names the ticket and the error',
  );
  assert.equal(runFixture.ticketResult(results)?.labelFailed, true);
  assert.equal(run.runExitCode(results), 1);
});

test('a crashed ticket keeps the reason from the later lines of the error', async (t) => {
  const fixture = runFixture.fixture(t, {
    responses: {
      'red/1/red/1': { throw: new Error('git push origin x exited 1\nremote: Permission to o/r denied to u') },
    },
  });
  const results = await run.runTarget(fixture.options);
  assert.match(runFixture.ticketResult(results)?.error as string, /Permission to o\/r denied/);
  const ticketEnd = fixture
    .readEvents()
    .find((event): event is events.TicketEndEvent => event.type === 'ticket_end' && event.ticket === TICKET);
  assert.match(ticketEnd?.error as string, /Permission to o\/r denied/);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
});

// Results as runTarget gives them, of which runExitCode reads only the fields given here.
const resultsOf = (...results: Omit<run.TicketResult, 'outcome'>[]) => results as run.TicketResult[];

test('runExitCode is non-zero when any ticket had a label failure, zero otherwise', () => {
  assert.equal(run.runExitCode(resultsOf({ ticket: 1, state: 'ready-for-qa' })), 0);
  assert.notEqual(run.runExitCode(resultsOf({ ticket: 1, state: 'ready-for-qa', labelFailed: true })), 0);
  assert.equal(
    run.runExitCode(
      resultsOf({ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa', labelFailed: true }),
    ),
    1,
  );
  assert.equal(
    run.runExitCode(resultsOf({ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa' })),
    2,
  );
});

const issue = (number: number, labels: string[] = [], extra = {}) => ({
  number,
  state: 'OPEN',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

test('epicProblem explains an epic with no sub-issues or nothing ready', () => {
  assert.match(run.epicProblem([], []) as string, /no sub-issues/i);
  const busy = [issue(2, [executionContext.IN_PROGRESS_LABEL])];
  assert.match(run.epicProblem(busy, []) as string, /nothing ready/i);
  assert.equal(run.epicProblem([issue(3)], [issue(3)]), null);
});

test('runTarget admits only ready tickets of an epic', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, {
    issues: epicRun.epicOf([21, 22, 23], { 23: { blockedBy: [{ number: 21, state: 'OPEN' }] } }),
  });
  fixture.options.target = EPIC;
  // Each red call waits for the other, so the two Executions overlap under maxParallel 2.
  const both = latch.latch();
  const reds = { count: 0 };
  epicRun.ticketHarnesses(fixture, [21, 22], {
    before: async (_ticket, call) => {
      if (call.phase !== 'red') return;
      if (++reds.count === 2) both.open();
      await both.wait();
    },
  });

  const results = await run.runTarget(fixture.options);
  assert.equal(fixture.options.config.user.maxParallel, 2);
  assert.deepEqual(
    outcomes(results),
    [
      [21, 'ready-for-qa'],
      [22, 'ready-for-qa'],
    ],
    JSON.stringify(results),
  );
  assert.equal(run.runExitCode(results), 0);
  const views = fixture.gh.calls
    .filter((call) => call.args[0] === 'issue' && call.args[1] === 'view')
    .map((call) => Number(call.args[2]));
  // A git write of one Ticket that waited for the repo lock behind the other reads its labels again, so count each
  // once.
  assert.deepEqual(
    [...new Set(views)].sort((first, second) => first - second),
    [EPIC, 21, 22, 23],
    'the epic and each sub-issue are read',
  );
  assert.equal(views.filter((number) => number === 23).length, 1, 'the blocked sub-issue only by discovery');
  const epicOfRecord = async (ticket: number) => record.load(fixture.commonDir, 'ticket', ticket)?.epic;
  assert.equal(await epicOfRecord(21), EPIC, "#21's Execution references the epic");
  assert.equal(await epicOfRecord(22), EPIC, "#22's Execution references the epic");
  await assertNotAdmitted(fixture, 23, 'the blocked Ticket has no record');
});

test('mapConcurrently never exceeds its limit and keeps result order', async () => {
  const started = [latch.latch(), latch.latch(), latch.latch(), latch.latch(), latch.latch()];
  const finish = [latch.latch(), latch.latch(), latch.latch(), latch.latch(), latch.latch()];
  const workers = { live: 0, peak: 0 };
  const pending = run.mapConcurrently([1, 2, 3, 4, 5], 2, async (item) => {
    workers.peak = Math.max(workers.peak, ++workers.live);
    started[item - 1]?.open();
    await finish[item - 1]?.wait();
    workers.live--;
    return item * 10;
  });
  await started[0]?.wait();
  await started[1]?.wait();
  assert.equal(workers.live, 2, 'two workers run at once');
  // Out of order, so the results must be put back in item order.
  finish[1]?.open();
  await started[2]?.wait();
  finish[0]?.open();
  await started[3]?.wait();
  finish[3]?.open();
  await started[4]?.wait();
  finish[2]?.open();
  finish[4]?.open();
  assert.deepEqual(await pending, [10, 20, 30, 40, 50]);
  assert.equal(workers.peak, 2);
});

test('an auth failure stops every active ticket and records the class on run_end', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]) });
  fixture.options.target = EPIC;
  const bInCall = latch.latch();
  const aEnded = latch.latch();
  runFixture.hookGh(fixture, async (args) => {
    if (epicRun.addsLabel(args, 21, executionContext.NEEDS_HUMAN_LABEL)) aEnded.open();
  });
  // A's red call fails with auth while B is inside its own red call; B's call returns once A has ended.
  epicRun.ticketHarnesses(fixture, [21, 22], {
    responses: { 21: { 'red/1/red/1': { failure: { failureClass: 'auth', message: 'Not logged in' } } } },
    before: async (ticket, call) => {
      if (call.phase !== 'red') return;
      if (ticket === 21) await bInCall.wait();
      else {
        bInCall.open();
        await aEnded.wait();
      }
    },
  });

  const results = await run.runTarget(fixture.options);
  assert.deepEqual(
    results.map((result) => [result.ticket, result.state]),
    [
      [21, 'needs-human'],
      [22, 'needs-human'],
    ],
    JSON.stringify(results),
  );
  assert.equal(run.runExitCode(results), 2);
  const runEvents = fixture.readEvents();
  const bActions = runEvents.filter(
    (event): event is events.ActionEvent => event.type === 'action' && event.ticket === 22 && !!event.procedure,
  );
  assert.deepEqual(
    bActions.map((event) => [event.vertex, event.action, event.recovery, event.outcome]),
    [['red', 'red', 0, 'ok']],
    'B finished its red call and started no other Action',
  );
  const bEnd = runEvents.find(
    (event): event is events.TicketEndEvent => event.type === 'ticket_end' && event.ticket === 22,
  );
  assert.equal(bEnd?.outcome, 'needs-human');
  assert.match(
    bEnd?.terminalReason?.text as string,
    /#21\b.*\bauth\b/,
    'the reason of B names the run-stopping failure',
  );
  const ends = runEvents.filter((event) => event.type === 'run_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.failureClass, 'auth');
  const ticketEnds = runEvents.flatMap((event, i) => (event.type === 'ticket_end' ? [i] : []));
  assert.equal(ticketEnds.length, 2);
  assert.ok(
    runEvents.indexOf(ends[0] as events.Event) > Math.max(...ticketEnds),
    'run_end follows both Ticket endings',
  );
});

test(
  "a ticket lock failure is that ticket's fault and run_end waits for every worker",
  { timeout: 120_000 },
  async (t) => {
    const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]) });
    fixture.options.target = EPIC;
    // A directory where B's ticket-lock database belongs cannot be opened, so taking B's lock throws.
    mkdirSync(join(fixture.commonDir, 'gg', 'locks', 'ticket-22.db'), { recursive: true });
    const bFailed = latch.latch();
    const aEnded = latch.latch();
    fixture.options.log = (line) => {
      fixture.logs.push(line);
      if (line.startsWith('[o/r] #22 ERROR')) bFailed.open();
    };
    runFixture.hookGh(fixture, async (args) => {
      if (epicRun.addsLabel(args, 21, 'gg:state:ready-for-qa')) aEnded.open();
    });
    // A is inside its red call when B's lock fails, and finishes only after.
    epicRun.ticketHarnesses(fixture, [21, 22], {
      before: async (ticket, call) => {
        if (ticket === 21 && call.phase === 'red') await bFailed.wait();
      },
    });

    const running = run.runTarget(fixture.options).then(
      (settled) => settled,
      (err: unknown) => err,
    );
    running.then(bFailed.open);
    const results = await running;
    await aEnded.wait();
    assert.ok(Array.isArray(results), `the Run settles with every Ticket's result: ${results}`);
    assert.deepEqual(outcomes(results), [
      [21, 'ready-for-qa'],
      [22, 'fault'],
    ]);
    assert.match(results[1]?.error as string, /unable to open database file/, 'the result keeps the acquisition error');
    assert.equal(run.runExitCode(results), 1);
    const runEvents = fixture.readEvents();
    const ends = runEvents.filter((event): event is events.RunEndEvent => event.type === 'run_end');
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0]?.tickets, [
      { ticket: 21, outcome: 'ready-for-qa' },
      { ticket: 22, outcome: 'fault' },
    ]);
    assert.ok(
      runEvents.indexOf(ends[0] as events.Event) >
        runEvents.findIndex((event) => event.type === 'ticket_end' && event.ticket === 21),
      'run_end follows the ending of A',
    );
  },
);

test('a run stop skips queued tickets without admitting them', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]) });
  fixture.options.target = EPIC;
  fixture.options.config.user.maxParallel = 1;
  const fakes = epicRun.ticketHarnesses(fixture, [21, 22], {
    responses: { 21: { 'red/1/red/1': { failure: { failureClass: 'auth', message: 'Not logged in' } } } },
  });

  const results = await run.runTarget(fixture.options);
  assert.deepEqual(
    outcomes(results),
    [
      [21, 'needs-human'],
      [22, 'skipped'],
    ],
    JSON.stringify(results),
  );
  assert.equal(fakes[22]?.calls.length, 0, 'no agent ran for the queued Ticket');
  await assertNotAdmitted(fixture, 22, 'the queued Ticket has no record');
  assert.equal(
    fixture.readEvents().find((event): event is events.RunEndEvent => event.type === 'run_end')?.failureClass,
    'auth',
  );
});

// #66: one cooldown for every Ticket of the Run.
test('a rate limit on one Ticket delays the next GitHub write of the other', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]) });
  fixture.options.target = EPIC;
  fixture.gh.fail({
    matches: (args) => fakeGh.isCommentPost(args, 21),
    status: 403,
    headers: { 'Retry-After': '7' },
    body: { message: 'You have exceeded a secondary rate limit.' },
  });
  const aWaiting = latch.latch();
  const woken = latch.latch();
  const sleeps: { ms: number; bCalls: number }[] = [];
  const bCalls = () =>
    fixture.gh.calls.filter(
      (call) => call.args.some((arg) => arg.startsWith('ticket/22-')) || fakeGh.isCommentPost(call.args, 22),
    ).length;
  // A backs off first; B's wait moves the shared clock once, to A's deadline, and wakes both.
  fixture.options.deps.clock = {
    ...fixture.clock,
    sleep: async (ms: number) => {
      sleeps.push({ ms, bCalls: bCalls() });
      if (sleeps.length === 1) aWaiting.open();
      else {
        await fixture.clock.sleep(ms);
        woken.open();
      }
      await woken.wait();
    },
  } as runContext.Deps['clock'];
  // B's red call starts once A is backing off.
  epicRun.ticketHarnesses(fixture, [21, 22], {
    before: async (ticket, call) => {
      if (ticket === 22 && call.phase === 'red') await aWaiting.wait();
    },
  });

  const results = await run.runTarget(fixture.options);
  assert.deepEqual(
    outcomes(results),
    [
      [21, 'ready-for-qa'],
      [22, 'ready-for-qa'],
    ],
    JSON.stringify(results),
  );
  assert.deepEqual(
    sleeps.map((sleep) => sleep.ms),
    [7_000, 7_000],
    "B waited out A's Retry-After",
  );
  assert.equal(sleeps[1]?.bCalls, 0, 'before any GitHub write of B');
  assert.equal(fixture.gh.calls.filter((call) => fakeGh.isCommentPost(call.args, 21)).length, 2);
  assert.equal(fixture.gh.comments.filter((comment) => comment.number === 21).length, 1);
});

const LOCKED_VERBS = [
  'ensureWorktree',
  'stageAll',
  'writeTree',
  'commitStaged',
  'commitTree',
  'push',
  'remoteSha',
  'resetTo',
  'rescueTree',
  'rescueCommit',
  'createRef',
] as const;

// A slow fetch in another process may hold the repo lock past acquire's default 60 s; snapshots and orchestrator writes
// wait longer, so contention does not become a fault. Each lock poll here takes a minute, as an overrunning sleep may.
test('snapshot and orchestrator writes wait beyond the default lock timeout', async (t) => {
  const fixture = runFixture.fixture(t);
  const clock = { now: 0 };
  const timed = locks.createLocks({
    clock: {
      now: () => clock.now,
      sleep: async () => {
        clock.now += 60_000;
      },
    },
  });
  const called: string[] = [];
  const recording = Object.fromEntries(
    LOCKED_VERBS.map((verb) => [
      verb,
      async () => {
        called.push(verb);
      },
    ]),
  );
  const git = run.lockedGit(recording as unknown as runContext.RunGit, fixture.commonDir, { locks: timed });
  // Another connection holds the lock, as another gg process would. Released before the fixture's cleanup, which
  // Windows refuses while the holder keeps the lock file open.
  const holder = (await locks.tryAcquire(fixture.commonDir, 'repo')) as locks.LockHandle;
  const waited = async () => {
    await assert.rejects(timed.acquire(fixture.commonDir, 'repo'), { message: 'lock repo still held after 60000ms' });
    assert.equal(clock.now, 60_000, 'the default wait gives up after a minute');
    await assert.rejects(integrity.snapshot(fixture.mainRoot, fixture.options.deps.git, timed), {
      message: 'lock repo still held after 600000ms',
    });
    assert.equal(clock.now, 660_000, 'the snapshot waits ten minutes more');
    return Promise.allSettled(LOCKED_VERBS.map((verb) => (git[verb] as () => Promise<unknown>)()));
  };
  const writes = await waited().finally(() => locks.release(holder));

  assert.deepEqual(
    [...new Set(writes.map((write) => (write.status === 'rejected' ? write.reason?.message : undefined)))],
    ['lock repo still held after 600000ms'],
    'every write waits as long',
  );
  assert.deepEqual(called, [], 'no write runs while another holder has the repo lock');
});
