import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as afterPhase from '../support/after-phase.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as gitShell from '../support/git-shell.ts';

type GoldenFixture = golden.GoldenFixture;

// A human amends the gg commit: same marker and parent, different tree.
function amendCommit(fixture: GoldenFixture) {
  writeFileSync(join(fixture.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  gitShell.sh(fixture.worktree, 'add', 'lib/extra.mjs');
  gitShell.sh(fixture.worktree, 'commit', '-q', '--amend', '--no-edit');
}
// Reconciliation of the crashed record holds it, naming the Action Marker it could not reconcile.
async function assertHoldNames(fixture: GoldenFixture, actionMarker: string) {
  const decided = await reconcile.reconcile(
    crashResume.reconcileOptions(fixture, await executionReads.loadTicket(fixture)),
  );
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason?.includes(actionMarker), `the reason names the marker: ${decided.reason}`);
}
const resumed = async (fixture: GoldenFixture) =>
  interpreter.runExecution({ ...fixture.options, record: await executionReads.loadTicket(fixture) });

test('an amended commit with the marker holds the ticket', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-effect');
  // A human amends the gg commit between the crash and the resume.
  amendCommit(fixture);
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'a human note\n');
  const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
  const status = gitShell.sh(fixture.worktree, 'status', '--porcelain');

  await assertHoldNames(fixture, actionMarker);

  await resumed(fixture);
  const final = await executionReads.loadTicket(fixture);
  assert.equal(final.state, 'held');
  assert.ok(fixture.gh.labels.has(executionContext.NEEDS_HUMAN_LABEL), 'the ticket is labelled needs-human');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.ok(existsSync(join(fixture.worktree, 'notes.txt')));
  assert.equal(await executionReads.originSha(fixture), null, 'nothing is pushed');
  assert.equal(fixture.harness.calls.length, 2);
});

test('a commit amended after its completion was saved holds the ticket', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'after-completion');
  // The commit is complete in the record, so no open intent points at it; the amend keeps its marker.
  amendCommit(fixture);
  const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');

  await assertHoldNames(fixture, actionMarker);

  await resumed(fixture);
  assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(await executionReads.originSha(fixture), null, 'the amended commit is not published');
  assert.equal(fixture.harness.calls.length, 2);
});

test('a crash before the commit replays the intended tree, not a human edit', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'a human note\n');

  const result = await resumed(fixture);
  // The replayed commit is pushed, but pr-ready never publishes beside the human's file (T1a), so nothing is marked
  // ready.
  assert.equal(result.outcome, 'needs-human');
  const final = await executionReads.loadTicket(fixture);
  assert.deepEqual(final.terminalReason?.decidedBy, { hold: 'unchecked-publish' });
  assert.match(
    final.terminalReason?.text as string,
    /its Check passed on tree \w+, not on tree \w+ of commit/,
    'the Check ran with the human file in the tree',
  );
  assert.equal(fixture.gh.pr()?.isDraft, true);
  const ofCommit = final.writeAheadLog.filter((entry) => entry.actionMarker === actionMarker);
  const payload = ofCommit.find((entry) => entry.step === 'intent')?.payload as { tree: string; parent: string };
  const { sha } = ofCommit.find((entry) => entry.step === 'evidence')?.evidence as { sha: string };
  assert.equal(
    gitShell.sh(fixture.worktree, 'rev-parse', `${sha}^{tree}`),
    payload.tree,
    'the commit has the intended tree',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', `${sha}^`), payload.parent, 'and the intended parent');
  assert.equal(readFileSync(join(fixture.worktree, 'notes.txt'), 'utf8'), 'a human note\n', 'the human edit is kept');
  assert.match(gitShell.sh(fixture.worktree, 'status', '--porcelain'), /\?\? notes\.txt/, 'and left uncommitted');
});

test('a branch moved before the commit replay holds the ticket', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.commit.place, 'before-effect');
  gitShell.sh(fixture.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');

  await assertHoldNames(fixture, actionMarker);

  await resumed(fixture);
  assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(await executionReads.originSha(fixture), null, 'nothing is pushed');
});

test('a branch moved before the push replay holds the ticket', async (t) => {
  const fixture = await golden.fixture(t, { git: 'real' });
  const { actionMarker } = await crashResume.crashed(fixture, crashResume.EFFECTS.push.place, 'before-effect');
  gitShell.sh(fixture.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');

  await assertHoldNames(fixture, actionMarker);

  await resumed(fixture);
  assert.equal((await executionReads.loadTicket(fixture)).state, 'held');
  assert.equal(await executionReads.originSha(fixture), null, 'the moved branch is not published');
});

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to
// needs-human. Before the effect the worktree is still as the violating call left it, so the record proves the
// rollback the agent's.
for (const point of ['before-effect', 'after-effect', 'after-completion'] as const) {
  test(`a crash ${point} of an integrity violation rollback does not call the harness again`, async (t) => {
    const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
    afterPhase.afterPhase(fixture, 'red', () => writeFileSync(join(fixture.worktree, 'CLAUDE.md'), 'an agent edit\n'));
    // The rollback's own marker.
    await crashResume.crashed(fixture, ['red', 1, 'reset', 0], point);
    assert.equal(fixture.harness.calls.length, 1);

    const result = await resumed(fixture);
    assert.equal(result.outcome, 'needs-human');
    assert.equal(fixture.harness.calls.length, 1, 'the violating call is not dispatched again');
    const final = await executionReads.loadTicket(fixture);
    assert.equal(final.state, 'needs-human');
    assert.deepEqual(final.terminalReason?.rule, { table: 'fixed', row: 'integrity-violation' });
    assert.equal(final.history.filter((item) => item.kind === 'integrity violation').length, 1);
    assert.ok(!existsSync(join(fixture.worktree, 'CLAUDE.md')), 'the violation stays rolled back');
  });
}
