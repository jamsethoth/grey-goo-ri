import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as reconcile from '../lib/reconcile.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';

// A failed red Phase whose reset is interrupted by a crash at `when`: before the reset, or after it.
async function crashedFailedRed(t, when) {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = g.options.git;
  g.options.git = { ...git, resetTo: async (...args) => {
    if (when === 'after reset') await git.resetTo(...args);
    throw new interpreter.CrashError('crash');
  } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  g.loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  return g;
}

const resetEntries = (rec) => rec.log.filter((e) => e.action === 'reset').map((e) => e.step);

test('a crash after the reset of a failed red keeps its History item exactly once', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  assert.deepEqual(g.loaded.history, [], 'the crash came before the History item was saved');
  assert.deepEqual(resetEntries(g.loaded), ['intent']);

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'continue');
  assert.equal(g.loaded.history.length, 1);
  assert.equal(g.loaded.history[0].kind, 'red phase failed');
  assert.match(g.loaded.history[0].text, /did not fail before implementation/);
  assert.deepEqual(resetEntries(g.loaded), ['intent', 'evidence', 'complete']);
  assert.deepEqual(record.openIntents(g.loaded), []);

  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(saved.history, g.loaded.history, 'the History item is persisted');
  assert.equal(await reconcile.resets(saved, { git: g.options.git }), 'continue');
  assert.equal(saved.history.length, 1, 'a second Reconciliation adds nothing');
});

test('a reset whose evidence was saved but not its completion is completed without a second History item', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/still-green/1': { files: {}, response: golden.redResponse } } });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  await interpreter.runExecution(g.options);
  const rec = await record.load(g.commonDir, 'ticket', golden.TICKET);
  rec.log = rec.log.filter((e) => !(e.action === 'reset' && e.step === 'complete'));

  assert.equal(await reconcile.resets(rec, { git: g.options.git }), 'continue');
  assert.equal(rec.history.length, 1);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
});

test('a crash before the reset holds the Execution and discards nothing', async (t) => {
  const g = await crashedFailedRed(t, 'before reset');
  const dirty = golden.sh(g.worktree, 'status', '--porcelain');
  assert.notEqual(dirty, '', 'the agent changes are still in the worktree');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), dirty, 'nothing is discarded at resume');
  assert.deepEqual(g.loaded.history, []);
  assert.equal(record.openIntents(g.loaded)[0].payload.history.kind, 'red phase failed', 'the reason waits in the open intent');
});

test('an assume-unchanged edit left at the baseline does not prove the reset done', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  const [tracked] = golden.sh(g.worktree, 'ls-files').split('\n');
  golden.sh(g.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(g.worktree, tracked), 'a hidden agent edit\n');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'git status cannot see it');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.deepEqual(g.loaded.history, []);
  assert.deepEqual(resetEntries(g.loaded), ['intent']);
});

test('a failed HEAD read after the reset of a failed red leaves the History item to Reconciliation, once', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['implementer/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
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
