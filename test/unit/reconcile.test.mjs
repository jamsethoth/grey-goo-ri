import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import * as interpreterSupport from '../support/interpreter.mjs';
import { resetEntries } from '../support/reconcile.mjs';

// The Ticket branch's log from its head: two commits since the base, the base, and the commit the base was cut from.
const branchLog = [
  { sha: 'c'.repeat(40), message: 'feat: b' },
  { sha: 'b'.repeat(40), message: 'feat: a' },
  { sha: 'a'.repeat(40), message: 'base' },
  { sha: '9'.repeat(40), message: 'before the base' },
];
const onBranch = (base) => ({ worktree: '/wt', base, options: { git: { commitLog: async () => branchLog } } });

test('branchMessages lists the commits since the base, oldest first', async () => {
  assert.deepEqual(await interpreterSupport.branchMessages(onBranch('a'.repeat(40))), ['feat: a', 'feat: b']);
});

test('branchMessages throws when the base is not in the log', async () => {
  await assert.rejects(interpreterSupport.branchMessages(onBranch('d'.repeat(40))), /base d{40} is not in the log/);
});

// An Integrity Violation at red's Attempt, which a reset rolls back.
const violating = (g) => ({
  ...g.options.integrity,
  end: async () => ({ violations: [{ worktree: g.worktree, surface: 'head', before: g.base, after: 'a'.repeat(40) }] }),
});

test('a reset whose evidence was saved but not its completion is completed without a second History item', async (t) => {
  const g = await golden.setup(t);
  await interpreter.runExecution({ ...g.options, integrity: violating(g) });
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  rec.writeAheadLog = rec.writeAheadLog.filter((e) => !(e.effect === 'reset' && e.step === 'complete'));

  assert.equal(await reconcile.resets(rec, { git: g.options.git }), 'continue');
  assert.equal(rec.history.length, 1);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
});

test('a failed HEAD read after the reset of an Integrity Violation leaves the History item to Reconciliation, once', async (t) => {
  const g = await golden.setup(t);
  g.options.integrity = violating(g);
  const git = g.options.git;
  let reset = false;
  g.options.git = {
    ...git,
    resetTo: async (...args) => {
      await git.resetTo(...args);
      reset = true;
    },
    headSha: async (cwd) => {
      if (reset) throw new interpreter.CrashError('head read failed');
      return git.headSha(cwd);
    },
  };
  await assert.rejects(interpreter.runExecution(g.options), /head read failed/);

  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(loaded.history, [], 'no History item is saved without the reset evidence');
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(loaded.history.length, 1);
});
