import { type TestContext, test } from 'node:test';
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
import * as run from '../../lib/run.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as epicRun from '../support/epic-run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as gitShell from '../support/git-shell.ts';
import * as latch from '../support/latch.ts';
import * as lockHolder from '../support/lock-holder.ts';
import * as runFixture from '../support/run-fixture.ts';

const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
type RunFixture = runFixture.RunFixture;

// The Runs below use the real integrity over the fake git: their subject is the repo lock and which worktree a change
// is attributed to, not git. Over real git, every git process of every snapshot was theirs, and under a full suite run
// they took up to ten times their time alone, 295 s for one (#187).

// Locks whose `allRefused` resolves once `count` first attempts at the repo lock have found it taken: each of `count`
// waiters is then waiting.
function refusedFirstAttempts(count: number) {
  const refused = { count: 0 };
  const all = latch.latch();
  const watched = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      const handle = await attempt();
      if (lock.name === 'repo' && !lock.waited && !handle && ++refused.count === count) all.open();
      return handle;
    },
  });
  return { locks: watched, allRefused: all.wait() };
}

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

test('every orchestrator git write waits for the repo lock', async (t) => {
  const fixture = runFixture.fixture(t);
  const holder = await lockHolder.holdLock(t, fixture.commonDir, 'repo');
  const called: string[] = [];
  const { locks: watched, allRefused: waiting } = refusedFirstAttempts(LOCKED_VERBS.length);
  const recording = Object.fromEntries(
    LOCKED_VERBS.map((verb) => [
      verb,
      async () => {
        called.push(verb);
      },
    ]),
  );
  const git = run.lockedGit(recording as unknown as runContext.RunGit, fixture.commonDir, { locks: watched });
  const pending = LOCKED_VERBS.map((verb) => (git[verb] as () => Promise<unknown>)());
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
  assert.deepEqual(called.sort(), [...LOCKED_VERBS].sort(), 'every write runs after release');
});

test('an integrity snapshot waits for the repo lock', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real' });
  const holder = await lockHolder.holdLock(t, fixture.commonDir, 'repo');
  const state = { settled: false };
  const { locks: watched, allRefused: waiting } = refusedFirstAttempts(1);
  const pending = integrity.snapshot(fixture.mainRoot, fixture.options.deps.git, watched).finally(() => {
    state.settled = true;
  });
  // Released before the fixture's cleanup, pass or fail: Windows refuses to remove the lock file the holder keeps open.
  try {
    await Promise.race([waiting, pending.catch(() => {})]);
    assert.equal(state.settled, false, 'the snapshot writes no object while another process holds the repo lock');
  } finally {
    await holder.release();
  }
  assert.equal((await pending).head, fixture.base, 'the snapshot runs after release');
});

// Another process takes the repo lock during the first harness call, after the worktree exists; `refused` opens once
// the Run is refused it.
function lockTakenDuringRed(t: TestContext, fixture: RunFixture) {
  const held: { holder: lockHolder.LockHolder | null } = { holder: null };
  const holding = latch.latch();
  const refused = latch.latch();
  const { run: call } = fixture.harness;
  fixture.options.harnesses.fake = {
    ...fixture.harness,
    run: async (harnessCall: Parameters<typeof call>[0]) => {
      if (!held.holder) {
        held.holder = await lockHolder.holdLock(t, fixture.commonDir, 'repo');
        holding.open();
      }
      return call(harnessCall);
    },
  };
  // While the holder has the lock no locked write runs, so the probe below never attempts it: a refusal is the run's.
  fixture.options.deps.locks = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      const handle = await attempt();
      if (held.holder && lock.name === 'repo' && !handle) refused.open();
      return handle;
    },
  });
  return { held, holding: holding.wait(), refused: refused.wait() };
}

// The git whose commit-path writes each note, by a probe of the repo lock, whether they ran outside it.
function probedCommitPath(fixture: RunFixture) {
  const unlocked: string[] = [];
  const git = fixture.options.deps.git;
  const probed = (verb: 'stageAll' | 'writeTree' | 'commitStaged' | 'push' | 'remoteSha') => [
    verb,
    async (...args: unknown[]) => {
      const probe = await locks.tryAcquire(fixture.commonDir, 'repo');
      if (probe) {
        unlocked.push(verb);
        await locks.release(probe);
      }
      return (git[verb] as (...verbArgs: unknown[]) => Promise<unknown>)(...args);
    },
  ];
  const verbs = ['stageAll', 'writeTree', 'commitStaged', 'push', 'remoteSha'] as const;
  fixture.options.deps.git = { ...git, ...Object.fromEntries(verbs.map(probed)) };
  return unlocked;
}

test('an orchestrator commit waits for the repo lock', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'fake' });
  const { held, holding, refused } = lockTakenDuringRed(t, fixture);
  // The snapshot after the call waits on the holder too, so each commit-path write must itself run inside the repo
  // lock.
  const git = fixture.options.deps.git;
  const unlocked = probedCommitPath(fixture);
  // The commits on the branch past main's one commit.
  const commits = async () => (await git.commitLog(fixture.mainRoot, runFixture.BRANCH)).length - 1;
  const state = { settled: false };
  const running = run.runTarget(fixture.options).finally(() => {
    state.settled = true;
  });
  // Ended before the case ends, pass or fail, so it never writes through the next case's fakes.
  try {
    await Promise.race([holding, running.catch(() => {})]);
    assert.ok(held.holder, 'the red call ran, so the worktree exists');
    await Promise.race([refused, running.catch(() => {})]);
    assert.equal(state.settled, false, 'the run waits while another process holds the repo lock');
    assert.equal(await commits(), 0, 'no commit lands while the repo lock is held');
    assert.equal(fixture.harness.calls.length, 1, 'the run is waiting at the red commit');

    await held.holder.release();
    const results = await running;
    assert.equal(run.runExitCode(results), 0);
    assert.ok((await commits()) >= 2, 'the commits land after release');
    assert.deepEqual(unlocked, [], 'every commit-path git write ran inside the repo lock');
  } finally {
    await held.holder?.release();
    await running.catch(() => {});
  }
});

const redOfTicket21 = (fixture: RunFixture) =>
  fixture
    .readEvents()
    .find(
      (event): event is events.AgentActionEvent =>
        event.type === 'action' && event.ticket === 21 && event.action === 'red' && event.agent,
    );

test('a stray write into an idle worktree is attributed to the running action', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]), integrity: 'real', git: 'fake' });
  fixture.options.target = epicRun.EPIC;
  const aAdmitted = latch.latch();
  const bIdle = latch.latch();
  const aEnded = latch.latch();
  // B starts only after A's admission has read the worktree list: B's ticket lock attempt waits for it. So only a
  // worktree list read per Attempt can see B.
  fixture.options.deps.locks = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      if (lock.name === 'ticket-22') await aAdmitted.wait();
      return attempt();
    },
  });
  // A runs its Execution while B is admitted and idle, and B goes on only once A has ended.
  runFixture.hookGh(fixture, async (args) => {
    if (epicRun.addsLabel(args, 21, IN_PROGRESS_LABEL)) {
      aAdmitted.open();
      await bIdle.wait();
    }
    if (epicRun.addsLabel(args, 22, IN_PROGRESS_LABEL)) {
      bIdle.open();
      await aEnded.wait();
    }
    if (epicRun.addsLabel(args, 21, NEEDS_HUMAN_LABEL)) aEnded.open();
  });
  const seen: { bActivity?: unknown } = {};
  epicRun.ticketHarnesses(fixture, [21, 22], {
    before: async (ticket, call) => {
      if (ticket !== 21 || call.phase !== 'red') return;
      seen.bActivity = (await record.load(fixture.commonDir, 'ticket', 22))?.activity;
      writeFileSync(join(epicRun.worktreeOf(fixture, 22), 'package.json'), '{ "stray": true }\n');
    },
  });

  const results = await run.runTarget(fixture.options);
  assert.deepEqual(seen.bActivity, { busy: false, generation: 0 }, 'B was admitted and idle during the red call of A');
  const red = redOfTicket21(fixture);
  assert.equal(red?.outcome, 'integrity-violation', JSON.stringify(results));
  const violations = red.integrityViolations as { worktree: string; surface: string }[];
  assert.ok(
    violations.some(
      (violation) =>
        paths.pathKey(violation.worktree) === paths.pathKey(epicRun.worktreeOf(fixture, 22)) &&
        violation.surface === 'tree',
    ),
    JSON.stringify(violations),
  );
});

test("a busy worktree is never attributed to another ticket's action", { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { issues: epicRun.epicOf([21, 22]), integrity: 'real', git: 'fake' });
  fixture.options.target = epicRun.EPIC;
  const bBusy = latch.latch();
  const aEnded = latch.latch();
  // A starts only once B is inside its red call, and B's call returns only once A has ended.
  runFixture.hookGh(fixture, async (args) => {
    if (epicRun.addsLabel(args, 21, IN_PROGRESS_LABEL)) await bBusy.wait();
    if (epicRun.addsLabel(args, 21, 'gg:state:ready-for-qa')) aEnded.open();
  });
  const seen: { bActivity?: { busy?: boolean } | null } = {};
  epicRun.ticketHarnesses(fixture, [21, 22], {
    before: async (ticket, call) => {
      if (call.phase !== 'red') return;
      if (ticket === 22) {
        bBusy.open();
        await aEnded.wait();
        return;
      }
      // B's own Action changes its worktree during A's.
      seen.bActivity = (await record.load(fixture.commonDir, 'ticket', 22))?.activity;
      writeFileSync(join(epicRun.worktreeOf(fixture, 22), 'b-at-work.txt'), 'B at work\n');
    },
  });

  const results = await run.runTarget(fixture.options);
  assert.equal(seen.bActivity?.busy, true, 'B was busy during the red call of A');
  assert.deepEqual(
    results.map((result) => [result.ticket, result.outcome]),
    [
      [21, 'ready-for-qa'],
      [22, 'ready-for-qa'],
    ],
    JSON.stringify(results),
  );
  const flagged = fixture
    .readEvents()
    .filter((event) => event.type === 'action' && event.ticket === 21 && event.integrityViolations);
  assert.deepEqual(flagged, [], 'no Action of A carries a violation');
});

const repoLockWriter = fileURLToPath(new URL('../support/repo-lock-writer.ts', import.meta.url));

// A process that commits on the repository's main branch while it holds the repo lock, reports its commit, and is
// told when to release.
async function lockedWriter(t: TestContext, fixture: RunFixture) {
  const child = spawn(process.execPath, [repoLockWriter, fixture.commonDir, fixture.mainRoot, 'child'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    shell: false,
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(() => child.kill());
  const { sha } = await new Promise<{ sha: string }>((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`the writer exited ${code} before reporting`)));
  });
  return { childSha: sha, release: () => child.send('release'), exited };
}

// Both processes appended to the one events table, in insertion order, and the reads give its rows as stored.
function assertOneEventsTable(fixture: RunFixture) {
  const appended = fixture.readEvents();
  assert.deepEqual(
    appended.map((event) => [event.run, event.type]),
    [
      ['parent', 'run_start'],
      ['child', 'run_start'],
      ['child', 'run_end'],
      ['parent', 'run_end'],
    ],
    'both processes appended to the one events table, in insertion order',
  );
  const rows = stateDatabase
    .open(fixture.commonDir)
    .prepare('SELECT json FROM events ORDER BY id')
    .all()
    .map((row) => JSON.parse((row as { json: string }).json));
  assert.deepEqual(appended, rows);
}

test('two processes serialise orchestrator git writes on the repo lock', { timeout: 120_000 }, async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real' });
  const log = events.eventLog(fixture.commonDir, { run: 'parent' });
  log('run_start');
  writeFileSync(join(fixture.mainRoot, 'parent.txt'), 'parent\n');
  gitShell.sh(fixture.mainRoot, 'add', 'parent.txt');
  const writer = await lockedWriter(t, fixture);
  // The child holds the repo lock now; the parent's commit is called while it does. Told to release, the child appends
  // its run_end before it releases, so the Events the parent's commit sees as it starts show which side of the release
  // it ran on, with no clock compared across the two processes (#260).
  const seen: { atCommit: [unknown, string][] | null } = { atCommit: null };
  const unlockedGit = fixture.options.deps.git;
  const git = run.lockedGit(
    {
      ...unlockedGit,
      commitStaged: (...args) => {
        seen.atCommit = fixture.readEvents().map((event) => [event.run, event.type]);
        return unlockedGit.commitStaged(...args);
      },
    },
    fixture.commonDir,
  );
  const committing = git.commitStaged(fixture.mainRoot, 'parent commit');
  writer.release();
  const parentSha = await committing;
  assert.equal(await writer.exited, 0, 'the writer exits cleanly');
  log('run_end');

  assert.deepEqual(
    seen.atCommit,
    [
      ['parent', 'run_start'],
      ['child', 'run_start'],
      ['child', 'run_end'],
    ],
    "the parent's commit started only after the child, told to release, appended its run_end",
  );
  assert.ok(parentSha, 'the parent commit landed without an index error');
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'rev-parse', `${parentSha}^`),
    writer.childSha,
    'the parent commit sits on the child commit',
  );
  assert.deepEqual(
    gitShell.sh(fixture.mainRoot, 'rev-list', 'main').split('\n').slice(0, 2),
    [parentSha, writer.childSha],
    'both shas are on the branch',
  );
  assertOneEventsTable(fixture);
});
