import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../../lib/events.ts';
import * as integrity from '../../lib/integrity.ts';
import * as locks from '../../lib/locks.ts';
import * as paths from '../../lib/paths.ts';
import * as record from '../../lib/record.ts';
import * as sqlite from '../../lib/sqlite.ts';
import * as run from '../../lib/run.mjs';
import {
  BRANCH,
  IN_PROGRESS,
  NEEDS_HUMAN,
  sh,
  fixture,
  holdLock,
  epicOf,
  EPIC,
  worktreeOf,
  addsLabel,
  gate,
  ticketHarnesses,
  hookGh,
} from '../support/run.mjs';

// The Runs below use the real integrity over the fake git: their subject is the repo lock and which worktree a change is
// attributed to, not git. Over real git, every git process of every snapshot was theirs, and under a full suite run
// they took up to ten times their time alone, 295 s for one (#187).

// Locks whose `allRefused` resolves once `n` first attempts at the repo lock have found it taken: each of `n` waiters is
// then waiting.
function refusedFirstAttempts(n) {
  let refused = 0;
  let all;
  const allRefused = new Promise((resolve) => {
    all = resolve;
  });
  const watched = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      const handle = await attempt();
      if (lock.name === 'repo' && !lock.waited && !handle && ++refused === n) all();
      return handle;
    },
  });
  return { locks: watched, allRefused };
}

test('every orchestrator git write waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  const called = [];
  const verbs = [
    'ensureWorktree',
    'stageAll',
    'writeTree',
    'commitStaged',
    'commitTree',
    'push',
    'remoteSha',
    'resetTo',
  ];
  const { locks: watched, allRefused: waiting } = refusedFirstAttempts(verbs.length);
  const git = run.lockedGit(
    Object.fromEntries(
      verbs.map((v) => [
        v,
        async () => {
          called.push(v);
        },
      ]),
    ),
    f.commonDir,
    { locks: watched },
  );
  const pending = verbs.map((v) => git[v]());
  // Released before the fixture's cleanup, pass or fail: Windows refuses to remove the lock file the holder keeps open.
  // And every write ends before that cleanup, so a late one cannot recreate the lock directory it removed.
  try {
    await Promise.race([waiting, ...pending]);
    // A copy: the writes that run after release must not change what a failure reports.
    assert.deepEqual([...called], [], 'no write runs while another process holds the repo lock');
  } finally {
    await holder.release();
    await Promise.allSettled(pending);
  }
  await Promise.all(pending);
  assert.deepEqual(called.sort(), [...verbs].sort(), 'every write runs after release');
});

test('an integrity snapshot waits for the repo lock', async (t) => {
  const f = fixture(t, { git: 'real' });
  const holder = await holdLock(t, f.commonDir, 'repo');
  let settled = false;
  const { locks: watched, allRefused: waiting } = refusedFirstAttempts(1);
  const pending = integrity.snapshot(f.mainRoot, f.options.git, watched).finally(() => {
    settled = true;
  });
  // Released before the fixture's cleanup, pass or fail: Windows refuses to remove the lock file the holder keeps open.
  try {
    await Promise.race([waiting, pending.catch(() => {})]);
    assert.equal(settled, false, 'the snapshot writes no object while another process holds the repo lock');
  } finally {
    await holder.release();
  }
  assert.equal((await pending).head, f.base, 'the snapshot runs after release');
});

test('an orchestrator commit waits for the repo lock', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { integrity: 'real', git: 'fake' });
  // The competing lock is taken during the red call, after the worktree exists.
  let holder = null;
  let held;
  const holding = new Promise((resolve) => {
    held = resolve;
  });
  const { run: call } = f.harness;
  f.options.harnesses.fake = {
    ...f.harness,
    run: async (c) => {
      if (!holder) {
        holder = await holdLock(t, f.commonDir, 'repo');
        held();
      }
      return call(c);
    },
  };
  // While the holder has the lock no locked write runs, so the probe below never attempts it: a refusal is the run's.
  let refused;
  const waiting = new Promise((resolve) => {
    refused = resolve;
  });
  f.options.locks = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      const handle = await attempt();
      if (holder && lock.name === 'repo' && !handle) refused();
      return handle;
    },
  });
  // The snapshot after the call waits on the holder too, so each commit-path write must itself run inside the repo lock.
  const unlocked = [];
  const git = f.options.git;
  f.options.git = {
    ...git,
    ...Object.fromEntries(
      ['stageAll', 'writeTree', 'commitStaged', 'push', 'remoteSha'].map((v) => [
        v,
        async (...args) => {
          const probe = await locks.tryAcquire(f.commonDir, 'repo');
          if (probe) {
            unlocked.push(v);
            await locks.release(probe);
          }
          return git[v](...args);
        },
      ]),
    ),
  };
  // The commits on the branch past main's one commit.
  const commits = async () => (await git.commitLog(f.mainRoot, BRANCH)).length - 1;
  let settled = false;
  const running = run.runTarget(f.options).finally(() => {
    settled = true;
  });
  // Ended before the case ends, pass or fail, so it never writes through the next case's fakes.
  try {
    await Promise.race([holding, running.catch(() => {})]);
    assert.ok(holder, 'the red call ran, so the worktree exists');
    await Promise.race([waiting, running.catch(() => {})]);
    assert.equal(settled, false, 'the run waits while another process holds the repo lock');
    assert.equal(await commits(), 0, 'no commit lands while the repo lock is held');
    assert.equal(f.harness.calls.length, 1, 'the run is waiting at the red commit');

    await holder.release();
    const results = await running;
    assert.equal(run.runExitCode(results), 0);
    assert.ok((await commits()) >= 2, 'the commits land after release');
    assert.deepEqual(unlocked, [], 'every commit-path git write ran inside the repo lock');
  } finally {
    await holder?.release();
    await running.catch(() => {});
  }
});

test('a stray write into an idle worktree is attributed to the running action', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]), integrity: 'real', git: 'fake' });
  f.options.target = EPIC;
  const aAdmitted = gate();
  const bIdle = gate();
  const aEnded = gate();
  // B starts only after A's admission has read the worktree list: B's ticket lock attempt waits for it. So only a
  // worktree list read per Attempt can see B.
  f.options.locks = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      if (lock.name === 'ticket-22') await aAdmitted.wait();
      return attempt();
    },
  });
  // A runs its Execution while B is admitted and idle, and B goes on only once A has ended.
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, IN_PROGRESS)) {
      aAdmitted.open();
      await bIdle.wait();
    }
    if (addsLabel(args, 22, IN_PROGRESS)) {
      bIdle.open();
      await aEnded.wait();
    }
    if (addsLabel(args, 21, NEEDS_HUMAN)) aEnded.open();
  });
  let bActivity;
  ticketHarnesses(f, [21, 22], {
    before: async (n, call) => {
      if (n !== 21 || call.phase !== 'red') return;
      bActivity = (await record.load(f.commonDir, 'ticket', 22))?.activity;
      writeFileSync(join(worktreeOf(f, 22), 'package.json'), '{ "stray": true }\n');
    },
  });

  const results = await run.runTarget(f.options);
  assert.deepEqual(bActivity, { busy: false, generation: 0 }, 'B was admitted and idle during the red call of A');
  const red = f.readEvents().find((e) => e.type === 'action' && e.ticket === 21 && e.action === 'red' && e.agent);
  assert.equal(red?.outcome, 'integrity-violation', JSON.stringify(results));
  assert.ok(
    red.integrityViolations.some(
      (v) => paths.pathKey(v.worktree) === paths.pathKey(worktreeOf(f, 22)) && v.surface === 'tree',
    ),
    JSON.stringify(red.integrityViolations),
  );
});

test("a busy worktree is never attributed to another ticket's action", { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { issues: epicOf([21, 22]), integrity: 'real', git: 'fake' });
  f.options.target = EPIC;
  const bBusy = gate();
  const aEnded = gate();
  // A starts only once B is inside its red call, and B's call returns only once A has ended.
  hookGh(f, async (args) => {
    if (addsLabel(args, 21, IN_PROGRESS)) await bBusy.wait();
    if (addsLabel(args, 21, 'gg:state:ready-for-qa')) aEnded.open();
  });
  let bActivity;
  ticketHarnesses(f, [21, 22], {
    before: async (n, call) => {
      if (call.phase !== 'red') return;
      if (n === 22) {
        bBusy.open();
        await aEnded.wait();
        return;
      }
      // B's own Action changes its worktree during A's.
      bActivity = (await record.load(f.commonDir, 'ticket', 22))?.activity;
      writeFileSync(join(worktreeOf(f, 22), 'b-at-work.txt'), 'B at work\n');
    },
  });

  const results = await run.runTarget(f.options);
  assert.equal(bActivity?.busy, true, 'B was busy during the red call of A');
  assert.deepEqual(
    results.map((r) => [r.ticket, r.outcome]),
    [
      [21, 'ready-for-qa'],
      [22, 'ready-for-qa'],
    ],
    JSON.stringify(results),
  );
  const flagged = f.readEvents().filter((e) => e.type === 'action' && e.ticket === 21 && e.integrityViolations);
  assert.deepEqual(flagged, [], 'no Action of A carries a violation');
});

const repoLockWriter = fileURLToPath(new URL('../support/repo-lock-writer.mjs', import.meta.url));

test('two processes serialise orchestrator git writes on the repo lock', { timeout: 120_000 }, async (t) => {
  const f = fixture(t, { git: 'real' });
  const log = events.eventLog(f.commonDir, { run: 'parent' });
  log('run_start');
  writeFileSync(join(f.mainRoot, 'parent.txt'), 'parent\n');
  sh(f.mainRoot, 'add', 'parent.txt');
  const child = spawn(process.execPath, [repoLockWriter, f.commonDir, f.mainRoot, 'child'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    shell: false,
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(() => child.kill());
  const { sha: childSha } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`the writer exited ${code} before reporting`)));
  });
  // The child holds the repo lock now; the parent's commit is called while it does. Told to release, the child appends
  // its run_end before it releases, so the Events the parent's commit sees as it starts show which side of the release
  // it ran on, with no clock compared across the two processes (#260).
  let seenAtCommit = null;
  const git = run.lockedGit(
    {
      ...f.options.git,
      commitStaged: (...args) => {
        seenAtCommit = f.readEvents().map((e) => [e.run, e.type]);
        return f.options.git.commitStaged(...args);
      },
    },
    f.commonDir,
  );
  const committing = git.commitStaged(f.mainRoot, 'parent commit');
  child.send('release');
  const parentSha = await committing;
  assert.equal(await exited, 0, 'the writer exits cleanly');
  log('run_end');

  assert.deepEqual(
    seenAtCommit,
    [
      ['parent', 'run_start'],
      ['child', 'run_start'],
      ['child', 'run_end'],
    ],
    "the parent's commit started only after the child, told to release, appended its run_end",
  );
  assert.ok(parentSha, 'the parent commit landed without an index error');
  assert.equal(sh(f.mainRoot, 'rev-parse', `${parentSha}^`), childSha, 'the parent commit sits on the child commit');
  assert.deepEqual(
    sh(f.mainRoot, 'rev-list', 'main').split('\n').slice(0, 2),
    [parentSha, childSha],
    'both shas are on the branch',
  );
  const evs = f.readEvents();
  assert.deepEqual(
    evs.map((e) => [e.run, e.type]),
    [
      ['parent', 'run_start'],
      ['child', 'run_start'],
      ['child', 'run_end'],
      ['parent', 'run_end'],
    ],
    'both processes appended to the one events table, in insertion order',
  );
  const rows = sqlite
    .openDb(f.commonDir)
    .prepare('SELECT json FROM events ORDER BY id')
    .all()
    .map((r) => JSON.parse(r.json));
  assert.deepEqual(evs, rows);
});
