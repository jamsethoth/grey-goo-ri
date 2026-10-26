import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  markerOf, withMarker, loadTicket, EFFECTS, POINTS, crashed, NEEDS_HUMAN, reconcileArgs,
} from '../support/reconcile.mjs';

test('a needs-human label overrides a mid-action record', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  g.gh.labels.add(NEEDS_HUMAN);
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'abandon');
  assert.equal((await loadTicket(g)).state, 'active', 'Reconciliation only decides the abandonment');

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(g.harness.calls.length, 2, 'the Execution is not resumed');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'the intended commit is not made');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.equal(g.gh.pr(), null);
});

test('dirtyState lists a non-ASCII untracked name verbatim', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  golden.sh(g.worktree, 'config', 'core.quotePath', 'true');
  writeFileSync(join(g.worktree, 'café notes.txt'), 'mine\n');
  const { stat } = await reconcile.dirtyState(null, { git: g.options.git, worktree: g.worktree });
  assert.ok(stat.includes(' café notes.txt (untracked)\n'), stat);
});

// Reconciliation holds a moved branch; the hold's comment then crashes. Any git call on resume would replay or check the
// older commit, which a hold only reports.
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of a hold comment resumes its reporting Actions without replaying an older commit`, async (t) => {
    const g = await golden.setup(t, { git: 'real' });
    await crashed(g, EFFECTS.commit.at, 'before-effect');
    golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
    const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
    const hold = markerOf(g.rec, 'needs-human', 1, 'hold', 1);
    await assert.rejects(interpreter.runExecution({ ...g.options, record: await loadTicket(g), crashAt: { marker: hold, point } }),
      (err) => err instanceof interpreter.CrashError);
    const mid = await loadTicket(g);
    const older = record.openIntents(mid).filter((e) => e.action === 'commit');
    assert.equal(older.length, 1);
    const git = new Proxy({}, { get: (_, verb) => () => { throw new Error(`git ${String(verb)} called`); } });

    const result = await interpreter.runExecution({ ...g.options, git, record: mid });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true, JSON.stringify(result));
    const final = await loadTicket(g);
    assert.equal(final.state, 'held');
    assert.deepEqual(record.openIntents(final), older, 'only the older commit intent stays open, untouched');
    assert.equal(withMarker(g.gh.comments.map((c) => c.body), hold).length, 1, 'the hold comment is posted once');
    assert.ok(g.gh.labels.has(NEEDS_HUMAN));
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
    assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.equal(g.harness.calls.length, 2);
  });
}

test('a hold report never looks up an older open PR-comment intent', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  // An earlier review comment on the PR crashed before its completion.
  const older = markerOf(g.rec, 'reviewer', 1, 'review', 4);
  await record.intent(await loadTicket(g), older, 'comment', { target: { kind: 'pr', number: 7 }, body: 'x', bodyHash: 'h' });
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const hold = markerOf(g.rec, 'needs-human', 1, 'hold', 1);
  await assert.rejects(interpreter.runExecution({ ...g.options, record: await loadTicket(g), crashAt: { marker: hold, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  let looked = 0;
  const gh = { ...g.options.gh, prComments: async () => { looked++; throw new Error('gh api exited 1\nHTTP 502: Bad Gateway'); } };

  const result = await interpreter.runExecution({ ...g.options, gh, record: await loadTicket(g) });
  assert.equal(looked, 0, "the older PR's comments are never read");
  assert.equal(result.held, true, JSON.stringify(result));
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(record.openIntents(final).some((e) => e.marker === older), 'the older intent stays open, untouched');
  assert.equal(withMarker(g.gh.comments.map((c) => c.body), hold).length, 1);
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});
