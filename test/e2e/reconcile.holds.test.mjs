import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import { EFFECTS, POINTS, crashed, reconcileOptions, withMarker } from '../support/crash-resume.ts';
import { NEEDS_HUMAN_LABEL } from '../support/execution-context.ts';
import { loadTicket } from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';

test('a needs-human label overrides a mid-action record', async (t) => {
  const g = await golden.fixture(t, { git: 'real' });
  await crashed(g, EFFECTS.commit.place, 'before-effect');
  g.gh.labels.add(NEEDS_HUMAN_LABEL);
  const head = gitShell.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = gitShell.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileOptions(g, await loadTicket(g)));
  assert.equal(decided.next, 'abandon');
  assert.equal((await loadTicket(g)).state, 'active', 'Reconciliation only decides the abandonment');

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(g.harness.calls.length, 2, 'the Execution is not resumed');
  assert.equal(gitShell.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'the intended commit is not made');
  assert.equal(gitShell.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.equal(g.gh.pr(), null);
});

test('dirtyState lists a non-ASCII untracked name verbatim', async (t) => {
  const g = await golden.fixture(t, { git: 'real' });
  gitShell.sh(g.worktree, 'config', 'core.quotePath', 'true');
  writeFileSync(join(g.worktree, 'café notes.txt'), 'mine\n');
  const { stat } = await reconcile.dirtyState(null, { git: g.options.deps.git, worktree: g.worktree });
  assert.ok(stat.includes(' café notes.txt (untracked)\n'), stat);
});

// Reconciliation holds a moved branch; the hold's comment then crashes. Any git call on resume would replay or check the
// older commit, which a hold only reports.
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of a hold comment resumes its reporting Actions without replaying an older commit`, async (t) => {
    const g = await golden.fixture(t, { git: 'real' });
    await crashed(g, EFFECTS.commit.place, 'before-effect');
    gitShell.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
    const head = gitShell.sh(g.worktree, 'rev-parse', 'HEAD');
    const hold = golden.markerOf(g.executionRecord, 'needs-human', 1, 'hold-comment', 0);
    await assert.rejects(
      interpreter.runExecution({ ...g.options, record: await loadTicket(g), crashAt: { marker: hold, point } }),
      (err) => err instanceof interpreter.CrashError,
    );
    const mid = await loadTicket(g);
    const older = writeAhead.openIntents(mid).filter((e) => e.effect === 'commit');
    assert.equal(older.length, 1);
    const git = new Proxy(
      {},
      {
        get: (_, verb) => () => {
          throw new Error(`git ${String(verb)} called`);
        },
      },
    );

    const result = await interpreter.runExecution({ ...g.options, deps: { ...g.options.deps, git }, record: mid });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true, JSON.stringify(result));
    const final = await loadTicket(g);
    assert.equal(final.state, 'held');
    assert.deepEqual(writeAhead.openIntents(final), older, 'only the older commit intent stays open, untouched');
    assert.equal(
      withMarker(
        g.gh.comments.map((c) => c.body),
        hold,
      ).length,
      1,
      'the hold comment is posted once',
    );
    assert.ok(g.gh.labels.has(NEEDS_HUMAN_LABEL));
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
    assert.equal(gitShell.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.equal(g.harness.calls.length, 2);
  });
}

test('a hold report never looks up an older open PR-comment intent', async (t) => {
  const g = await golden.fixture(t, { git: 'real' });
  await crashed(g, EFFECTS.commit.place, 'before-effect');
  // An earlier review comment on the PR crashed before its completion.
  const older = golden.markerOf(g.executionRecord, 'reviewer', 1, 'pr', 0);
  await record.intent(await loadTicket(g), older, 'comment', {
    target: { kind: 'pr', number: 7 },
    body: 'x',
    bodyHash: 'h',
  });
  gitShell.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const hold = golden.markerOf(g.executionRecord, 'needs-human', 1, 'hold-comment', 0);
  await assert.rejects(
    interpreter.runExecution({
      ...g.options,
      record: await loadTicket(g),
      crashAt: { marker: hold, point: 'before-effect' },
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  let looked = 0;
  const gh = {
    ...g.options.deps.gh,
    // One read serves an issue and a PR, so only the PR's is counted.
    comments: async (n, cwd) => {
      if (n !== 7) return g.options.deps.gh.comments(n, cwd);
      looked++;
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    },
  };

  const result = await interpreter.runExecution({
    ...g.options,
    deps: { ...g.options.deps, gh },
    record: await loadTicket(g),
  });
  assert.equal(looked, 0, "the older PR's comments are never read");
  assert.equal(result.held, true, JSON.stringify(result));
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(
    writeAhead.openIntents(final).some((e) => e.actionMarker === older),
    'the older intent stays open, untouched',
  );
  assert.equal(
    withMarker(
      g.gh.comments.map((c) => c.body),
      hold,
    ).length,
    1,
  );
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});
