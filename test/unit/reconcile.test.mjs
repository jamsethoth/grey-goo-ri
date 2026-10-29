import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import { resetEntries } from '../support/reconcile.mjs';

// An Integrity Violation at red's Attempt, which a reset rolls back.
const violating = (g) => ({ ...g.options.integrity,
  end: async () => ({ violations: [{ worktree: g.worktree, surface: 'head', before: g.base, after: 'a'.repeat(40) }] }) });

test('a reset whose evidence was saved but not its completion is completed without a second History item', async (t) => {
  const g = await golden.setup(t);
  await interpreter.runExecution({ ...g.options, integrity: violating(g) });
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  rec.log = rec.log.filter((e) => !(e.action === 'reset' && e.step === 'complete'));

  assert.equal(await reconcile.resets(rec, { git: g.options.git }), 'continue');
  assert.equal(rec.history.length, 1);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
});

test('a failed HEAD read after the reset of an Integrity Violation leaves the History item to Reconciliation, once', async (t) => {
  const g = await golden.setup(t);
  g.options.integrity = violating(g);
  const git = g.options.git;
  let reset = false;
  g.options.git = { ...git,
    resetTo: async (...args) => { await git.resetTo(...args); reset = true; },
    headSha: async (cwd) => { if (reset) throw new interpreter.CrashError('head read failed'); return git.headSha(cwd); } };
  await assert.rejects(interpreter.runExecution(g.options), /head read failed/);

  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(loaded.history, [], 'no History item is saved without the reset evidence');
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(loaded.history.length, 1);
});
