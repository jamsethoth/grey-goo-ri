import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import * as events from '../lib/events.mjs';
import * as gitModule from '../lib/git.mjs';
import * as github from '../lib/github.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as locks from '../lib/locks.mjs';
import { pathKey } from '../lib/paths.mjs';
import * as record from '../lib/record.mjs';
import * as run from '../lib/run.mjs';
import * as golden from './support/golden.mjs';
import { fakeHarness } from './support/fake-harness.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, holdLock, ticketResult, EPIC, epicOf,
} from './support/run.mjs';

test('a held ticket lock skips the ticket', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, `ticket-${TICKET}`);
  await run.runTarget(f.options);
  // Released before the fixture's cleanup, which Windows refuses while the holder keeps the lock file open.
  await holder.release();
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /lock/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no repository label setup on a held lock');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('every orchestrator git write waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  const called = [];
  const verbs = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
  const git = run.lockedGit(Object.fromEntries(verbs.map((v) => [v, async () => { called.push(v); }])), f.commonDir);
  const pending = verbs.map((v) => git[v]());
  await sleep(500);
  assert.deepEqual(called, [], 'no write runs while another process holds the repo lock');
  await holder.release();
  await Promise.all(pending);
  assert.deepEqual(called.sort(), [...verbs].sort(), 'every write runs after release');
});

test('an integrity snapshot waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  let settled = false;
  const pending = integrity.snapshot(f.mainRoot).finally(() => { settled = true; });
  await sleep(500);
  assert.equal(settled, false, 'the snapshot writes no object while another process holds the repo lock');
  await holder.release();
  assert.equal((await pending).head, f.base, 'the snapshot runs after release');
});

// A slow fetch in another process may hold the repo lock past acquire's default 60 s; snapshots and orchestrator writes
// wait longer, so contention does not become a fault.
test('snapshot and orchestrator writes wait beyond the default lock timeout', { timeout: 180_000 }, async (t) => {
  const f = fixture(t);
  // The holder outlasts the test and is released only after the default waiter times out, however slow the setup.
  const holder = await holdLock(t, f.commonDir, 'repo', 180_000);
  const lockDir = join(f.commonDir, 'gg', 'locks');
  const mkdir = fsPromises.mkdir;
  const unobserve = () => { fsPromises.mkdir = mkdir; syncBuiltinESMExports(); };
  t.after(unobserve);
  try {
    // The snapshot's first attempt is seen before the default waiter starts, so its own deadline would pass first.
    let tried;
    const attempted = new Promise((resolve) => { tried = resolve; });
    fsPromises.mkdir = (path, ...rest) => { if (pathKey(String(path)) === pathKey(lockDir)) tried(); return mkdir(path, ...rest); };
    syncBuiltinESMExports();
    const settled = new Set();
    const track = (name, p) => p.then((v) => { settled.add(name); return v; }, (e) => { settled.add(name); throw e; });
    const snapshot = track('snapshot', integrity.snapshot(f.mainRoot));
    await attempted;
    unobserve();
    const called = [];
    const verbs = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
    const git = run.lockedGit(Object.fromEntries(verbs.map((v) => [v, async () => { called.push(v); }])), f.commonDir);
    const writes = verbs.map((v) => track(v, git[v]()));

    await assert.rejects(locks.acquire(f.commonDir, 'repo'), (err) => err instanceof locks.LockTimeoutError && err.message.includes('60000ms'));
    assert.deepEqual([...settled], [], 'the snapshot and every write still wait');
    assert.deepEqual(called, [], 'no write runs while another process holds the repo lock');
    await holder.release();
    assert.equal((await snapshot).head, f.base, 'the snapshot runs after release');
    await Promise.all(writes);
    assert.deepEqual(called.sort(), [...verbs].sort(), 'every write runs after release');
  } finally {
    await holder.release();
  }
});

test('an orchestrator commit waits for the repo lock', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { integrity: 'real' });
  // The competing lock is taken during the red call, after the worktree exists.
  let holder = null;
  const { run: call } = f.harness;
  f.options.harnesses.fake = { ...f.harness, run: async (c) => { holder ??= await holdLock(t, f.commonDir, 'repo'); return call(c); } };
  // The snapshot after the call waits on the holder too, so each commit-path write must itself run inside the repo lock.
  const unlocked = [];
  f.options.git = { ...gitModule, ...Object.fromEntries(['stageAll', 'writeTree', 'commitStaged', 'push', 'remoteSha'].map((v) => [v, async (...args) => {
    const probe = await locks.tryAcquire(f.commonDir, 'repo');
    if (probe) {
      unlocked.push(v);
      await locks.release(probe);
    }
    return gitModule[v](...args);
  }])) };
  const commits = () => {
    const r = spawnSync('git', ['rev-list', '--count', `main..refs/heads/${BRANCH}`], { cwd: f.mainRoot, encoding: 'utf8' });
    return r.status === 0 ? Number(r.stdout.trim()) : 0;
  };
  let settled = false;
  const running = run.runTarget(f.options).finally(() => { settled = true; });
  // Ended before the case ends, pass or fail, so it never writes through the next case's fakes.
  try {
    // The case timeout bounds this wait, and ends it so the finally below runs: a 10 s bound of its own ran out before
    // the red call on a loaded machine.
    while (!holder && !settled) await sleep(50, undefined, { signal: t.signal });
    assert.ok(holder, 'the red call ran, so the worktree exists');
    // shortcut: an absence check, so on a loaded machine the run may not yet have reached the lock; it never fails falsely
    await sleep(1000);
    assert.equal(settled, false, 'the run waits while another process holds the repo lock');
    assert.equal(commits(), 0, 'no commit lands while the repo lock is held');
    assert.equal(f.harness.calls.length, 1, 'the run is waiting at the red commit');

    await holder.release();
    const results = await running;
    assert.equal(run.runExitCode(results), 0);
    assert.ok(commits() >= 2, 'the commits land after release');
    assert.deepEqual(unlocked, [], 'every commit-path git write ran inside the repo lock');
  } finally {
    await holder?.release();
    await running.catch(() => {});
  }
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
  const f = fixture(t, { responses: { 'implementer/1/red/1': { throw: new Error('git push origin x exited 1\nremote: Permission to o/r denied to u') } } });
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

const repoLockWriter = fileURLToPath(new URL('./support/repo-lock-writer.mjs', import.meta.url));

const worktreeOf = (f, n) => gitModule.worktreePath(f.options.config.worktreeRoot, 'main', n);
const addsLabel = (args, n, label) => args[0] === 'issue' && args[1] === 'edit' && args[2] === String(n)
  && args.some((a, i) => a === label && args[i - 1] === '--add-label');

// Opened once. A broken interleaving fails at its case's timeout; a shorter bound of its own failed correct
// interleavings whenever the machine was loaded enough that the other Ticket's whole Execution outlasted it.
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

// One fake Harness per Ticket behind the name `fake`, chosen by the worktree each call runs in; `before` runs first.
function ticketHarnesses(f, tickets, { responses = {}, before = async () => {} } = {}) {
  const fakes = Object.fromEntries(tickets.map((n) => [n, fakeHarness({ transcriptDir: join(f.root, 'transcripts', String(n)),
    responses: responses[n] ?? golden.firstVisitResponses, capabilities: { cost: false, reasoningTokens: false } })]));
  const ticketOf = (cwd) => tickets.find((n) => pathKey(cwd) === pathKey(worktreeOf(f, n)));
  f.options.harnesses.fake = { ...fakes[tickets[0]], run: async (call) => {
    const n = ticketOf(call.cwd);
    await before(n, call);
    return fakes[n].run(call);
  } };
  return fakes;
}

// Every gh call passes through `hook` first.
function hookGh(f, hook) {
  const inner = f.gh.gh;
  github.setGh(async (args, cwd, input) => {
    await hook(args);
    return inner(args, cwd, input);
  });
}

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
  for (const n of [21, 22]) assert.equal((await record.load(f.commonDir, 'ticket', n))?.epic, EPIC, `#${n}'s Execution references the epic`);
  assert.equal(await record.load(f.commonDir, 'ticket', 23), null, 'the blocked Ticket has no record');
  assert.equal(existsSync(worktreeOf(f, 23)), false, 'nor a worktree');
  assert.ok(!f.gh.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'edit' && c.args[2] === '23'), 'nor a label edit');
  assert.ok(!f.readEvents().some((e) => e.ticket === 23), 'nor a Ticket Event');
});

test('pool never exceeds its limit and keeps result order', async () => {
  let live = 0, peak = 0;
  const res = await run.pool([1, 2, 3, 4, 5], 2, async (x) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return x * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res, [10, 20, 30, 40, 50]);
});

test('a stray write into an idle worktree is attributed to the running action', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]), integrity: 'real' });
  f.options.target = EPIC;
  const aAdmitted = gate();
  const bIdle = gate();
  const aEnded = gate();
  // B starts only after A's admission has read the worktree list: the pool takes A's ticket lock first, and B's waits
  // at the second lock-directory mkdir. So only a worktree list read per Attempt can see B.
  const lockDir = join(f.commonDir, 'gg', 'locks');
  const mkdir = fsPromises.mkdir;
  let lockDirs = 0;
  fsPromises.mkdir = async (path, ...rest) => {
    if (pathKey(String(path)) === pathKey(lockDir) && ++lockDirs === 2) await aAdmitted.wait();
    return mkdir(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.mkdir = mkdir; syncBuiltinESMExports(); });
  // A runs its Execution while B is admitted and idle, and B goes on only once A has ended.
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, IN_PROGRESS)) { aAdmitted.open(); await bIdle.wait(); }
    if (addsLabel(args, 22, IN_PROGRESS)) { bIdle.open(); await aEnded.wait(); }
    if (addsLabel(args, 21, NEEDS_HUMAN)) aEnded.open();
  });
  let bActivity;
  ticketHarnesses(f, [21, 22], { before: async (n, call) => {
    if (n !== 21 || call.phase !== 'red') return;
    bActivity = (await record.load(f.commonDir, 'ticket', 22))?.activity;
    writeFileSync(join(worktreeOf(f, 22), 'package.json'), '{ "stray": true }\n');
  } });

  const results = await run.runTarget(f.options);
  assert.deepEqual(bActivity, { busy: false, generation: 0 }, 'B was admitted and idle during the red call of A');
  const red = f.readEvents().find((e) => e.type === 'action' && e.ticket === 21 && e.phase === 'red' && e.agent);
  assert.equal(red?.outcome, 'integrity-violation', JSON.stringify(results));
  assert.ok(red.violations.some((v) => pathKey(v.worktree) === pathKey(worktreeOf(f, 22)) && v.surface === 'tree'), JSON.stringify(red.violations));
});

test('a busy worktree is never attributed to another ticket\'s action', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]), integrity: 'real' });
  f.options.target = EPIC;
  const bBusy = gate();
  const aEnded = gate();
  // A starts only once B is inside its red call, and B's call returns only once A has ended.
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, IN_PROGRESS)) await bBusy.wait();
    if (addsLabel(args, 21, 'gg:state:ready-for-qa')) aEnded.open();
  });
  let bActivity;
  ticketHarnesses(f, [21, 22], { before: async (n, call) => {
    if (call.phase !== 'red') return;
    if (n === 22) {
      bBusy.open();
      await aEnded.wait();
      return;
    }
    // B's own Action changes its worktree during A's.
    bActivity = (await record.load(f.commonDir, 'ticket', 22))?.activity;
    writeFileSync(join(worktreeOf(f, 22), 'b-at-work.txt'), 'B at work\n');
  } });

  const results = await run.runTarget(f.options);
  assert.equal(bActivity?.busy, true, 'B was busy during the red call of A');
  assert.deepEqual(results.map((r) => [r.ticket, r.outcome]), [[21, 'done'], [22, 'done']], JSON.stringify(results));
  const flagged = f.readEvents().filter((e) => e.type === 'action' && e.ticket === 21 && e.violations);
  assert.deepEqual(flagged, [], 'no Action of A carries a violation');
});

test('two processes serialise orchestrator git writes on the repo lock', { timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  const log = events.eventLog(f.commonDir, { run: 'parent' });
  log('run_start');
  writeFileSync(join(f.mainRoot, 'parent.txt'), 'parent\n');
  sh(f.mainRoot, 'add', 'parent.txt');
  const child = spawn(process.execPath, [repoLockWriter, f.commonDir, f.mainRoot, 'child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], shell: false });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(() => child.kill());
  const message = () => new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`the writer exited ${code} before reporting`)));
  });

  const { sha: childSha } = await message();
  // The child holds the repo lock now; the parent's commit is called while it does.
  let started = null;
  const git = run.lockedGit({ ...gitModule, commitStaged: (...args) => { started = Date.now(); return gitModule.commitStaged(...args); } }, f.commonDir);
  const committing = git.commitStaged(f.mainRoot, 'parent commit');
  const released = message();
  child.send('release');
  const { releasing } = await released;
  const parentSha = await committing;
  const committed = Date.now();
  assert.equal(await exited, 0, 'the writer exits cleanly');
  log('run_end');

  assert.ok(started >= releasing, `the parent's commit started at ${started}, after the child's release at ${releasing}`);
  assert.ok(committed >= releasing, 'and landed after it');
  assert.ok(parentSha, 'the parent commit landed without an index error');
  assert.equal(sh(f.mainRoot, 'rev-parse', `${parentSha}^`), childSha, 'the parent commit sits on the child commit');
  assert.deepEqual(sh(f.mainRoot, 'rev-list', 'main').split('\n').slice(0, 2), [parentSha, childSha], 'both shas are on the branch');
  const evs = f.readEvents();
  assert.deepEqual(evs.map((e) => [e.run, e.type]), [['parent', 'run_start'], ['child', 'run_start'], ['child', 'run_end'], ['parent', 'run_end']],
    'both processes appended to the one events table, in insertion order');
  const rows = record.openDb(f.commonDir).prepare('SELECT json FROM events ORDER BY id').all().map((r) => JSON.parse(r.json));
  assert.deepEqual(evs, rows);
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
    responses: { 21: { 'implementer/1/red/1': { failure: { class: 'auth', message: 'Not logged in' } } } },
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
  assert.deepEqual(bActions.map((e) => [e.phase, e.ordinal, e.outcome]), [['red', 1, 'ok']], 'B finished its red call and started no other Action');
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
    responses: { 21: { 'implementer/1/red/1': { failure: { class: 'auth', message: 'Not logged in' } } } },
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
  f.options.clock = { now: f.clock.now, sleep: async (ms) => {
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
