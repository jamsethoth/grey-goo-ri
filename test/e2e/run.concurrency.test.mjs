import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../../lib/events.mjs';
import * as integrity from '../../lib/integrity.mjs';
import * as locks from '../../lib/locks.mjs';
import { pathKey } from '../../lib/paths.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import {
  BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, holdLock, epicOf, EPIC, worktreeOf, addsLabel, gate, ticketHarnesses, hookGh,
} from '../support/run.mjs';

// Resolves once `n` first attempts at the repo lock have found it taken: each of `n` waiters is then waiting.
function refusedFirstAttempts(t, n) {
  let refused = 0;
  let all;
  const allRefused = new Promise((resolve) => { all = resolve; });
  const previous = locks.setAttemptWrapper(async (lock, attempt) => {
    const handle = await attempt();
    if (lock.name === 'repo' && !lock.waited && !handle && ++refused === n) all();
    return handle;
  });
  t.after(() => locks.setAttemptWrapper(previous));
  return allRefused;
}

test('every orchestrator git write waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  const called = [];
  const verbs = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
  const waiting = refusedFirstAttempts(t, verbs.length);
  const git = run.lockedGit(Object.fromEntries(verbs.map((v) => [v, async () => { called.push(v); }])), f.commonDir);
  const pending = verbs.map((v) => git[v]());
  await Promise.race([waiting, ...pending]);
  assert.deepEqual(called, [], 'no write runs while another process holds the repo lock');
  await holder.release();
  await Promise.all(pending);
  assert.deepEqual(called.sort(), [...verbs].sort(), 'every write runs after release');
});

test('an integrity snapshot waits for the repo lock', async (t) => {
  const f = fixture(t, { git: 'real' });
  const holder = await holdLock(t, f.commonDir, 'repo');
  let settled = false;
  const waiting = refusedFirstAttempts(t, 1);
  const pending = integrity.snapshot(f.mainRoot, f.options.git).finally(() => { settled = true; });
  await Promise.race([waiting, pending.catch(() => {})]);
  assert.equal(settled, false, 'the snapshot writes no object while another process holds the repo lock');
  await holder.release();
  assert.equal((await pending).head, f.base, 'the snapshot runs after release');
});

// A slow fetch in another process may hold the repo lock past acquire's default 60 s; snapshots and orchestrator writes
// wait longer, so contention does not become a fault.
test('snapshot and orchestrator writes wait beyond the default lock timeout', { timeout: 180_000 }, async (t) => {
  const f = fixture(t, { git: 'real' });
  // The holder outlasts the test and is released only after the default waiter times out, however slow the setup.
  const holder = await holdLock(t, f.commonDir, 'repo', 180_000);
  try {
    // The snapshot's first attempt is refused before the default waiter starts, so its own deadline would pass first.
    const attempted = refusedFirstAttempts(t, 1);
    const settled = new Set();
    const track = (name, p) => p.then((v) => { settled.add(name); return v; }, (e) => { settled.add(name); throw e; });
    const snapshot = track('snapshot', integrity.snapshot(f.mainRoot, f.options.git));
    await attempted;
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
  let held;
  const holding = new Promise((resolve) => { held = resolve; });
  const { run: call } = f.harness;
  f.options.harnesses.fake = { ...f.harness, run: async (c) => {
    if (!holder) {
      holder = await holdLock(t, f.commonDir, 'repo');
      held();
    }
    return call(c);
  } };
  // While the holder has the lock no locked write runs, so the probe below never attempts it: a refusal is the run's.
  let refused;
  const waiting = new Promise((resolve) => { refused = resolve; });
  const previous = locks.setAttemptWrapper(async (lock, attempt) => {
    const handle = await attempt();
    if (holder && lock.name === 'repo' && !handle) refused();
    return handle;
  });
  t.after(() => locks.setAttemptWrapper(previous));
  // The snapshot after the call waits on the holder too, so each commit-path write must itself run inside the repo lock.
  const unlocked = [];
  const git = f.options.git;
  f.options.git = { ...git, ...Object.fromEntries(['stageAll', 'writeTree', 'commitStaged', 'push', 'remoteSha'].map((v) => [v, async (...args) => {
    const probe = await locks.tryAcquire(f.commonDir, 'repo');
    if (probe) {
      unlocked.push(v);
      await locks.release(probe);
    }
    return git[v](...args);
  }])) };
  const commits = () => {
    const r = spawnSync('git', ['rev-list', '--count', `main..refs/heads/${BRANCH}`], { cwd: f.mainRoot, encoding: 'utf8' });
    return r.status === 0 ? Number(r.stdout.trim()) : 0;
  };
  let settled = false;
  const running = run.runTarget(f.options).finally(() => { settled = true; });
  // Ended before the case ends, pass or fail, so it never writes through the next case's fakes.
  try {
    await Promise.race([holding, running.catch(() => {})]);
    assert.ok(holder, 'the red call ran, so the worktree exists');
    await Promise.race([waiting, running.catch(() => {})]);
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

test('a stray write into an idle worktree is attributed to the running action', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]), integrity: 'real' });
  f.options.target = EPIC;
  const aAdmitted = gate();
  const bIdle = gate();
  const aEnded = gate();
  // B starts only after A's admission has read the worktree list: B's ticket lock attempt waits for it. So only a
  // worktree list read per Attempt can see B.
  const previous = locks.setAttemptWrapper(async (lock, attempt) => {
    if (lock.name === 'ticket-22') await aAdmitted.wait();
    return attempt();
  });
  t.after(() => locks.setAttemptWrapper(previous));
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

const repoLockWriter = fileURLToPath(new URL('../support/repo-lock-writer.mjs', import.meta.url));

test('two processes serialise orchestrator git writes on the repo lock', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { git: 'real' });
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
  const git = run.lockedGit({ ...f.options.git, commitStaged: (...args) => { started = Date.now(); return f.options.git.commitStaged(...args); } }, f.commonDir);
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
