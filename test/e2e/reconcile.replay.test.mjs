import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as golden from '../support/golden.mjs';
import {
  originSha, loadTicket, EFFECTS, crashed, NEEDS_HUMAN, reconcileArgs,
} from '../support/reconcile.mjs';

test('an amended commit with the marker holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-effect');
  // A human amends the gg commit between the crash and the resume: same marker and parent, different tree.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN), 'the ticket is labelled needs-human');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.ok(existsSync(join(g.worktree, 'notes.txt')));
  assert.equal(await originSha(g), null, 'nothing is pushed');
  assert.equal(g.harness.calls.length, 2);
});

test('a commit amended after its completion was saved holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-completion');
  // The commit is complete in the record, so no open intent points at it; the amend keeps its marker.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(await originSha(g), null, 'the amended commit is not published');
  assert.equal(g.harness.calls.length, 2);
});

test('a crash before the commit replays the intended tree, not a human edit', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');

  const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  // The replayed commit is pushed, but pr-ready never publishes beside the human's file (T1a), so nothing is marked ready.
  assert.equal(result.outcome, 'needs-human');
  const final = await loadTicket(g);
  assert.deepEqual(final.terminalReason.decidedBy, { hold: 'unchecked-publish' });
  assert.match(final.terminalReason.text, /its Check passed on tree \w+, not on tree \w+ of commit/, 'the Check ran with the human file in the tree');
  assert.equal(g.gh.pr().isDraft, true);
  const { payload } = final.log.find((e) => e.marker === m && e.step === 'intent');
  const { sha } = final.log.find((e) => e.marker === m && e.step === 'evidence').evidence;
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^{tree}`), payload.tree, 'the commit has the intended tree');
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^`), payload.parent, 'and the intended parent');
  assert.equal(readFileSync(join(g.worktree, 'notes.txt'), 'utf8'), 'a human note\n', 'the human edit is kept');
  assert.match(golden.sh(g.worktree, 'status', '--porcelain'), /\?\? notes\.txt/, 'and left uncommitted');
});

test('a branch moved before the commit replay holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(await originSha(g), null, 'nothing is pushed');
});

test('a branch moved before the push replay holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real' });
  const { m } = await crashed(g, EFFECTS.push.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(await originSha(g), null, 'the moved branch is not published');
});

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to
// needs-human. Before the effect the worktree is still as the violating call left it, so the record proves the
// rollback the agent's.
for (const point of ['before-effect', 'after-effect', 'after-completion']) {
  test(`a crash ${point} of an integrity violation rollback does not call the harness again`, async (t) => {
    const g = await golden.setup(t, { integrity: 'real' });
    const run = g.harness.run;
    g.harness.run = async (call) => {
      const out = await run(call);
      if (call.phase === 'red') writeFileSync(join(g.worktree, 'CLAUDE.md'), 'an agent edit\n');
      return out;
    };
    // The rollback's own marker.
    await crashed(g, ['red', 1, 'reset', 0], point);
    assert.equal(g.harness.calls.length, 1);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(g.harness.calls.length, 1, 'the violating call is not dispatched again');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human');
    assert.equal(final.terminalReason.rule, 'integrity-violation');
    assert.equal(final.history.filter((h) => h.kind === 'integrity violation').length, 1);
    assert.ok(!existsSync(join(g.worktree, 'CLAUDE.md')), 'the violation stays rolled back');
  });
}
