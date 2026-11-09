import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';

const { NEEDS_HUMAN_LABEL } = executionContext;
type GoldenFixture = golden.GoldenFixture;

const ticketEnds = (fixture: GoldenFixture) => fixture.readEvents().filter((event) => event.type === 'ticket_end');
const holdComments = (fixture: GoldenFixture, hold: string) =>
  crashResume.withMarker(
    fixture.gh.comments.map((comment) => comment.body),
    hold,
  );

test('a needs-human label overrides a mid-action record', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
  fixture.gh.labels.add(NEEDS_HUMAN_LABEL);
  const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
  const status = gitShell.sh(fixture.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(crashResume.reconcileOptions(fixture, executionReads.loadTicket(fixture)));
  assert.equal(decided.next, 'abandon');
  assert.equal(executionReads.loadTicket(fixture).state, 'active', 'Reconciliation only decides the abandonment');

  await interpreter.runExecution({ ...fixture.options, record: executionReads.loadTicket(fixture) });
  assert.equal(executionReads.loadTicket(fixture).state, 'abandoned');
  assert.equal(fixture.harness.calls.length, 2, 'the Execution is not resumed');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'the intended commit is not made');
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.equal(fixture.gh.pr(), null);
});

test('dirtyState lists a non-ASCII untracked name verbatim', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  gitShell.sh(fixture.worktree, 'config', 'core.quotePath', 'true');
  writeFileSync(join(fixture.worktree, 'café notes.txt'), 'mine\n');
  const dirty = await reconcile.dirtyState(null, { git: fixture.options.deps.git, worktree: fixture.worktree });
  const stat = dirty?.stat as string;
  assert.ok(stat.includes(' café notes.txt (untracked)\n'), stat);
});

// Reconciliation holds a moved branch; the hold's comment then crashes. Any git call on resume would replay or check
// the older commit, which a hold only reports.
for (const point of Object.keys(crashResume.POINTS) as (keyof typeof crashResume.POINTS)[]) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`a crash ${point} of a hold comment resumes its reporting Actions without replaying an older commit`, async (t) => {
    const fixture = await golden.fixture(t, { git: 'real' });
    await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
    gitShell.sh(fixture.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
    const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
    const hold = golden.markerOf(fixture.executionRecord, 'needs-human', 1, 'hold-comment', 0);
    await assert.rejects(
      interpreter.runExecution({
        ...fixture.options,
        record: executionReads.loadTicket(fixture),
        crashAt: { marker: hold, point },
      }),
      (err) => err instanceof interpreter.CrashError,
    );
    const mid = executionReads.loadTicket(fixture);
    const older = writeAhead.openIntents(mid).filter((entry) => entry.effect === 'commit');
    assert.equal(older.length, 1);
    const git = new Proxy(
      {},
      {
        get: (_, verb) => () => {
          throw new Error(`git ${String(verb)} called`);
        },
      },
    ) as runContext.RunGit;

    const result = await interpreter.runExecution({
      ...fixture.options,
      deps: { ...fixture.options.deps, git },
      record: mid,
    });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true, JSON.stringify(result));
    const final = executionReads.loadTicket(fixture);
    assert.equal(final.state, 'held');
    assert.deepEqual(writeAhead.openIntents(final), older, 'only the older commit intent stays open, untouched');
    assert.equal(holdComments(fixture, hold).length, 1, 'the hold comment is posted once');
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
    assert.equal(ticketEnds(fixture).length, 1);
    assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.equal(fixture.harness.calls.length, 2);
  });
}

test('a hold report never looks up an older open PR-comment intent', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
  // An earlier review comment on the PR crashed before its completion.
  const older = golden.markerOf(fixture.executionRecord, 'reviewer', 1, 'pr', 0);
  record.intent(executionReads.loadTicket(fixture), older, 'comment', {
    target: { kind: 'pr', number: 7 },
    body: 'x',
    bodyHash: 'h',
  });
  gitShell.sh(fixture.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const hold = golden.markerOf(fixture.executionRecord, 'needs-human', 1, 'hold-comment', 0);
  await assert.rejects(
    interpreter.runExecution({
      ...fixture.options,
      record: executionReads.loadTicket(fixture),
      crashAt: { marker: hold, point: 'before-effect' },
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  const looked = { count: 0 };
  const gh: typeof fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    // One read serves an issue and a PR, so only the PR's is counted.
    comments: async (number, cwd) => {
      if (number !== 7) return fixture.options.deps.gh.comments(number, cwd);
      looked.count++;
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    },
  };

  const result = await interpreter.runExecution({
    ...fixture.options,
    deps: { ...fixture.options.deps, gh },
    record: executionReads.loadTicket(fixture),
  });
  assert.equal(looked.count, 0, "the older PR's comments are never read");
  assert.equal(result.held, true, JSON.stringify(result));
  const final = executionReads.loadTicket(fixture);
  assert.equal(final.state, 'held');
  assert.ok(
    writeAhead.openIntents(final).some((entry) => entry.actionMarker === older),
    'the older intent stays open, untouched',
  );
  assert.equal(holdComments(fixture, hold).length, 1);
  assert.equal(ticketEnds(fixture).length, 1);
});
