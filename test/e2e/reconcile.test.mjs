import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import { resetEntries } from '../support/reconcile.mjs';

// A failed red Phase whose reset is interrupted by a crash at `when`: before the reset, or after it.
async function crashedFailedRed(t, when) {
  const responses = structuredClone(golden.firstVisitResponses);
  responses['red/1/still-green/1'] = { files: {}, response: golden.redResponse };
  const g = await golden.setup(t, { responses, integrity: 'real' });
  g.options.exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = g.options.git;
  g.options.git = { ...git, resetTo: async (...args) => {
    if (when === 'after reset') await git.resetTo(...args);
    throw new interpreter.CrashError('crash');
  } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  g.loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  g.git = git;
  return g;
}

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

test('a crash before the reset is finished by Reconciliation while the worktree is as the agent left it', async (t) => {
  const g = await crashedFailedRed(t, 'before reset');
  assert.notEqual(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the agent changes are still in the worktree');

  assert.equal(await reconcile.resets(g.loaded, { git: g.git }), 'continue');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', "the record proves the changes the agent's, so they are discarded");
  assert.deepEqual(g.loaded.history.map((h) => h.kind), ['red phase failed']);
  assert.deepEqual(resetEntries(g.loaded), ['intent', 'evidence', 'complete']);
});

test('a crash before the reset holds the Execution and discards nothing once a human changed the worktree', async (t) => {
  const g = await crashedFailedRed(t, 'before reset');
  writeFileSync(join(g.worktree, 'human.txt'), 'mine\n');
  const dirty = golden.sh(g.worktree, 'status', '--porcelain');

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

test('an ignored test added after an interrupted reset holds the restore and is kept', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  writeFileSync(join(g.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  mkdirSync(join(g.worktree, 'test'), { recursive: true });
  writeFileSync(join(g.worktree, 'test', 'human.test.mjs'), 'mine\n');

  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'held');
  assert.equal(readFileSync(join(g.worktree, 'test', 'human.test.mjs'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.deepEqual(resetEntries(g.loaded), ['intent']);
});

test('a crash between the reset and the Protected File restore of an integrity violation is finished by Reconciliation', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  mkdirSync(join(g.worktree, '.claude'), { recursive: true });
  writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(g.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') writeFileSync(local, '{"agent":true}\n');
    return out;
  };
  const git = g.options.git;
  g.options.git = { ...git, resetTo: async (...args) => {
    await git.resetTo(...args);
    throw new interpreter.CrashError('crash');
  } };
  await assert.rejects(interpreter.runExecution(g.options), /crash/);
  assert.equal(readFileSync(local, 'utf8'), '{"agent":true}\n', 'the crash came before the restore');

  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', "the owner's bytes come back from the saved intent");
  assert.equal(loaded.history[0].kind, 'integrity violation');
  assert.deepEqual(record.openIntents(loaded), []);
});

test('Reconciliation uses an injected integrity', async (t) => {
  const g = await crashedFailedRed(t, 'after reset');
  // The real worktree is clean at the reset's baseline, so only the injected integrity can make it look a human's.
  const elsewhere = { head: 'elsewhere', index: 'elsewhere', tree: 'elsewhere' };
  const integrity = { snapshot: async () => elsewhere, isCleanAt: async () => false, untrackedFiles: async () => ({}), ignoredFiles: async () => ({}) };
  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git, integrity }), 'held');
  assert.deepEqual(await reconcile.dirtyState(null, { git: g.options.git, worktree: g.worktree, integrity }), { conflicts: [], stat: '' });
  assert.equal(await reconcile.resets(g.loaded, { git: g.options.git }), 'continue');
});
