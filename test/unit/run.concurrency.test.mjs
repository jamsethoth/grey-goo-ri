import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.mjs';
import * as locks from '../../lib/locks.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import {
  TICKET, IN_PROGRESS, NEEDS_HUMAN, fixture, ticketResult, EPIC, epicOf, worktreeOf, addsLabel, gate, ticketHarnesses, hookGh,
} from '../support/run.mjs';

test('a held ticket lock skips the ticket', async (t) => {
  const f = fixture(t);
  // Another connection holds the lock, as another gg process would.
  const holder = await locks.tryAcquire(f.commonDir, `ticket-${TICKET}`);
  // Released before the fixture's cleanup, which Windows refuses while the holder keeps the lock file open.
  try {
    await run.runTarget(f.options);
  } finally {
    await locks.release(holder);
  }
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /lock/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no repository label setup on a held lock');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('in-progress is set only after the worktree exists', async (t) => {
  const f = fixture(t);
  // A plain directory where the worktree belongs makes ensureWorktree fail.
  mkdirSync(f.worktree, { recursive: true });
  writeFileSync(join(f.worktree, 'stray.txt'), 'not a worktree\n');
  await run.runTarget(f.options).catch(() => {});
  assert.ok(!f.labelAdds().includes(IN_PROGRESS), `in-progress was never added: ${JSON.stringify(f.labelAdds())}`);
  assert.ok(!f.gh.labels.has(IN_PROGRESS));
  assert.equal(f.harness.calls.length, 0);
});

test('a failed label update reaches the log, the event and the exit code', async (t) => {
  const f = fixture(t, { failEdit: true });
  const results = await run.runTarget(f.options);
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && l.includes('HTTP 502')), `log names the ticket and the error: ${JSON.stringify(f.logs)}`);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET && e.error.includes('HTTP 502')), 'event names the ticket and the error');
  assert.equal(ticketResult(results).labelFailed, true);
  assert.equal(run.runExitCode(results), 1);
});

test('a crashed ticket keeps the reason from the later lines of the error', async (t) => {
  const f = fixture(t, { responses: { 'red/1/red/1': { throw: new Error('git push origin x exited 1\nremote: Permission to o/r denied to u') } } });
  const results = await run.runTarget(f.options);
  assert.match(ticketResult(results).error, /Permission to o\/r denied/);
  assert.match(f.readEvents().find((e) => e.type === 'ticket_end' && e.ticket === TICKET).error, /Permission to o\/r denied/);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
});

test('runExitCode is non-zero when any ticket had a label failure, zero otherwise', () => {
  assert.equal(run.runExitCode([{ ticket: 1, state: 'ready-for-qa' }]), 0);
  assert.notEqual(run.runExitCode([{ ticket: 1, state: 'ready-for-qa', labelFailed: true }]), 0);
  assert.equal(run.runExitCode([{ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa', labelFailed: true }]), 1);
  assert.equal(run.runExitCode([{ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa' }]), 2);
});

const issue = (number, labels = [], extra = {}) => ({ number, state: 'OPEN', labels: labels.map((name) => ({ name })), ...extra });

test('epicProblem explains an epic with no sub-issues or nothing ready', () => {
  assert.match(run.epicProblem([], []), /no sub-issues/i);
  const busy = [issue(2, [IN_PROGRESS])];
  assert.match(run.epicProblem(busy, []), /nothing ready/i);
  assert.equal(run.epicProblem([issue(3)], [issue(3)]), null);
});

test('runTarget admits only ready tickets of an epic', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22, 23], { 23: { blockedBy: [{ number: 21, state: 'OPEN' }] } }) });
  f.options.target = EPIC;
  // Each red call waits for the other, so the two Executions overlap under maxParallel 2.
  const both = gate();
  let reds = 0;
  ticketHarnesses(f, [21, 22], { before: async (n, call) => {
    if (call.phase !== 'red') return;
    if (++reds === 2) both.open();
    await both.wait();
  } });

  const results = await run.runTarget(f.options);
  assert.equal(f.options.config.maxParallel, 2);
  assert.deepEqual(results.map((r) => [r.ticket, r.outcome]), [[21, 'done'], [22, 'done']], JSON.stringify(results));
  assert.equal(run.runExitCode(results), 0);
  const views = f.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'view').map((c) => Number(c.args[2]));
  // A git write of one Ticket that waited for the repo lock behind the other reads its labels again, so count each once.
  assert.deepEqual([...new Set(views)].sort((a, b) => a - b), [EPIC, 21, 22, 23], 'the epic and each sub-issue are read');
  assert.equal(views.filter((n) => n === 23).length, 1, 'the blocked sub-issue only by discovery');
  assert.equal((await record.load(f.commonDir, 'ticket', 21))?.epic, EPIC, "#21's Execution references the epic");
  assert.equal((await record.load(f.commonDir, 'ticket', 22))?.epic, EPIC, "#22's Execution references the epic");
  assert.equal(await record.load(f.commonDir, 'ticket', 23), null, 'the blocked Ticket has no record');
  assert.equal(existsSync(worktreeOf(f, 23)), false, 'nor a worktree');
  assert.ok(!f.gh.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'edit' && c.args[2] === '23'), 'nor a label edit');
  assert.ok(!f.readEvents().some((e) => e.ticket === 23), 'nor a Ticket Event');
});

test('pool never exceeds its limit and keeps result order', async () => {
  const started = [gate(), gate(), gate(), gate(), gate()];
  const finish = [gate(), gate(), gate(), gate(), gate()];
  let live = 0, peak = 0;
  const pending = run.pool([1, 2, 3, 4, 5], 2, async (x) => {
    peak = Math.max(peak, ++live);
    started[x - 1].open();
    await finish[x - 1].wait();
    live--;
    return x * 10;
  });
  await started[0].wait();
  await started[1].wait();
  assert.equal(live, 2, 'two workers run at once');
  // Out of order, so the results must be put back in item order.
  finish[1].open();
  await started[2].wait();
  finish[0].open();
  await started[3].wait();
  finish[3].open();
  await started[4].wait();
  finish[2].open();
  finish[4].open();
  assert.deepEqual(await pending, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});

test('an auth failure stops every active ticket and records the class on run_end', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]) });
  f.options.target = EPIC;
  const bInCall = gate();
  const aEnded = gate();
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, NEEDS_HUMAN)) aEnded.open();
  });
  // A's red call fails with auth while B is inside its own red call; B's call returns once A has ended.
  ticketHarnesses(f, [21, 22], {
    responses: { 21: { 'red/1/red/1': { failure: { class: 'auth', message: 'Not logged in' } } } },
    before: async (n, call) => {
      if (call.phase !== 'red') return;
      if (n === 21) await bInCall.wait();
      else {
        bInCall.open();
        await aEnded.wait();
      }
    },
  });

  const results = await run.runTarget(f.options);
  assert.deepEqual(results.map((r) => [r.ticket, r.state]), [[21, 'needs-human'], [22, 'needs-human']], JSON.stringify(results));
  assert.equal(run.runExitCode(results), 2);
  const evs = f.readEvents();
  const bActions = evs.filter((e) => e.type === 'action' && e.ticket === 22 && e.procedure);
  assert.deepEqual(bActions.map((e) => [e.vertex, e.action, e.recovery, e.outcome]), [['red', 'red', 0, 'ok']], 'B finished its red call and started no other Action');
  const bEnd = evs.find((e) => e.type === 'ticket_end' && e.ticket === 22);
  assert.equal(bEnd.outcome, 'needs-human');
  assert.match(bEnd.reason.text, /#21\b.*\bauth\b/, 'the reason of B names the run-stopping failure');
  const ends = evs.filter((e) => e.type === 'run_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].failureClass, 'auth');
  const ticketEnds = evs.flatMap((e, i) => (e.type === 'ticket_end' ? [i] : []));
  assert.equal(ticketEnds.length, 2);
  assert.ok(evs.indexOf(ends[0]) > Math.max(...ticketEnds), 'run_end follows both Ticket endings');
});

test('a ticket lock failure is that ticket\'s fault and run_end waits for every worker', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]) });
  f.options.target = EPIC;
  // A directory where B's ticket-lock database belongs cannot be opened, so taking B's lock throws.
  mkdirSync(join(f.commonDir, 'gg', 'locks', 'ticket-22.db'), { recursive: true });
  const bFailed = gate();
  const aEnded = gate();
  f.options.log = (m) => {
    f.logs.push(m);
    if (m.startsWith('[main] #22 ERROR')) bFailed.open();
  };
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, 'gg:state:ready-for-qa')) aEnded.open();
  });
  // A is inside its red call when B's lock fails, and finishes only after.
  ticketHarnesses(f, [21, 22], { before: async (n, call) => {
    if (n === 21 && call.phase === 'red') await bFailed.wait();
  } });

  const running = run.runTarget(f.options).then((r) => r, (e) => e);
  running.then(bFailed.open);
  const results = await running;
  await aEnded.wait();
  assert.ok(Array.isArray(results), `the Run settles with every Ticket's result: ${results}`);
  assert.deepEqual(results.map((r) => [r.ticket, r.outcome]), [[21, 'done'], [22, 'fault']]);
  assert.match(results[1].error, /unable to open database file/, 'the result keeps the acquisition error');
  assert.equal(run.runExitCode(results), 1);
  const evs = f.readEvents();
  const ends = evs.filter((e) => e.type === 'run_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].tickets, [{ ticket: 21, outcome: 'done' }, { ticket: 22, outcome: 'fault' }]);
  assert.ok(evs.indexOf(ends[0]) > evs.findIndex((e) => e.type === 'ticket_end' && e.ticket === 21), 'run_end follows the ending of A');
});

test('a run stop skips queued tickets without admitting them', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]) });
  f.options.target = EPIC;
  f.options.config.maxParallel = 1;
  const fakes = ticketHarnesses(f, [21, 22], {
    responses: { 21: { 'red/1/red/1': { failure: { class: 'auth', message: 'Not logged in' } } } },
  });

  const results = await run.runTarget(f.options);
  assert.deepEqual(results.map((r) => [r.ticket, r.outcome]), [[21, 'needs-human'], [22, 'skipped']], JSON.stringify(results));
  assert.equal(fakes[22].calls.length, 0, 'no agent ran for the queued Ticket');
  assert.equal(await record.load(f.commonDir, 'ticket', 22), null, 'the queued Ticket has no record');
  assert.equal(existsSync(worktreeOf(f, 22)), false, 'nor a worktree');
  assert.ok(!f.gh.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'edit' && c.args[2] === '22'), 'nor a label edit');
  const evs = f.readEvents();
  assert.ok(!evs.some((e) => e.ticket === 22), 'nor a Ticket Event');
  assert.equal(evs.find((e) => e.type === 'run_end').failureClass, 'auth');
});

// #66: one cooldown for every Ticket of the Run.
test('a rate limit on one Ticket delays the next GitHub write of the other', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]) });
  f.options.target = EPIC;
  f.gh.fail({ matches: (args) => golden.isCommentPost(args, 21), status: 403, headers: { 'Retry-After': '7' },
    body: { message: 'You have exceeded a secondary rate limit.' } });
  const aWaiting = gate();
  const sleeps = [];
  let wake;
  const woken = new Promise((resolve) => { wake = resolve; });
  const bCalls = () => f.gh.calls.filter((c) => c.args.some((a) => a.startsWith('ticket/22-')) || golden.isCommentPost(c.args, 22)).length;
  // A backs off first; B's wait moves the shared clock once, to A's deadline, and wakes both.
  f.options.clock = { ...f.clock, sleep: async (ms) => {
    sleeps.push({ ms, bCalls: bCalls() });
    if (sleeps.length === 1) aWaiting.open();
    else {
      await f.clock.sleep(ms);
      wake();
    }
    await woken;
  } };
  // B's red call starts once A is backing off.
  ticketHarnesses(f, [21, 22], { before: async (n, call) => {
    if (n === 22 && call.phase === 'red') await aWaiting.wait();
  } });

  const results = await run.runTarget(f.options);
  assert.deepEqual(results.map((r) => [r.ticket, r.outcome]), [[21, 'done'], [22, 'done']], JSON.stringify(results));
  assert.deepEqual(sleeps.map((s) => s.ms), [7_000, 7_000], "B waited out A's Retry-After");
  assert.equal(sleeps[1].bCalls, 0, 'before any GitHub write of B');
  assert.equal(f.gh.calls.filter((c) => golden.isCommentPost(c.args, 21)).length, 2);
  assert.equal(f.gh.comments.filter((c) => c.number === 21).length, 1);
});

// A slow fetch in another process may hold the repo lock past acquire's default 60 s; snapshots and orchestrator writes
// wait longer, so contention does not become a fault. Each lock poll here takes a minute, as an overrunning sleep may.
test('snapshot and orchestrator writes wait beyond the default lock timeout', async (t) => {
  const f = fixture(t);
  let now = 0;
  const previous = locks.setClock({ now: () => now, sleep: async () => { now += 60_000; } });
  t.after(() => locks.setClock(previous));
  const called = [];
  const verbs = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
  const git = run.lockedGit(Object.fromEntries(verbs.map((v) => [v, async () => { called.push(v); }])), f.commonDir);
  // Another connection holds the lock, as another gg process would. Released before the fixture's cleanup, which
  // Windows refuses while the holder keeps the lock file open.
  const holder = await locks.tryAcquire(f.commonDir, 'repo');
  let byDefault, snapshot, writes;
  try {
    byDefault = await locks.acquire(f.commonDir, 'repo').then(() => null, (err) => ({ message: err.message, at: now }));
    snapshot = await integrity.snapshot(f.mainRoot, f.options.git).then(() => null, (err) => ({ message: err.message, at: now }));
    writes = await Promise.allSettled(verbs.map((v) => git[v]()));
  } finally {
    await locks.release(holder);
  }

  assert.deepEqual(byDefault, { message: 'lock repo still held after 60000ms', at: 60_000 }, 'the default wait gives up after a minute');
  assert.deepEqual(snapshot, { message: 'lock repo still held after 600000ms', at: 660_000 }, 'the snapshot waits ten minutes more');
  assert.deepEqual([...new Set(writes.map((w) => w.reason?.message))], ['lock repo still held after 600000ms'], 'every write waits as long');
  assert.deepEqual(called, [], 'no write runs while another holder has the repo lock');
});
