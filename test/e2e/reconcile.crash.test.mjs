import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import { resetEntries } from '../support/reconcile.mjs';

// The baseline an Integrity Violation's rollback restores: ignored Protected Files, an untracked test git clean removes,
// and an ignored file outside the rollback, which the agent changes and the restore must leave alone.
const RESTORED = { '.claude/.gitignore': '*\n', '.claude/settings.local.json': '{"owner":true}\n', 'test/owner.test.mjs': 'owner\n' };
// Where restoreUntracked is crashed: it removes the extra .claude/agent.json (rm 1), then rewrites settings.local.json
// (rm 2, writeFile 1) and recreates test/owner.test.mjs (rm 3, writeFile 2).
const RESTORE_CRASHES = {
  'after deleting an extra': { op: 'rm', n: 1, after: true },
  'after removing a destination before its rewrite': { op: 'rm', n: 2, after: true },
  'after the first restored file': { op: 'writeFile', n: 1, after: true },
  'after the final write before evidence': { op: 'writeFile', n: 2, after: true },
};

async function crashedRestore(t, crash) {
  const g = await golden.setup(t, { integrity: 'real' });
  for (const [p, text] of Object.entries(RESTORED)) {
    mkdirSync(join(g.worktree, p, '..'), { recursive: true });
    writeFileSync(join(g.worktree, p), text);
  }
  // A tdd Visit starts clean, so the untracked test stays ignored until red runs; git clean then removes it.
  const exclude = join(g.commonDir, 'info', 'exclude');
  writeFileSync(exclude, 'scratch.log\ntest/owner.test.mjs\n');
  writeFileSync(join(g.worktree, 'scratch.log'), 'owner log\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      writeFileSync(join(g.worktree, '.claude', 'settings.local.json'), '{"agent":true}\n');
      writeFileSync(join(g.worktree, '.claude', 'agent.json'), '{}\n');
      writeFileSync(join(g.worktree, 'scratch.log'), 'agent log\n');
      writeFileSync(exclude, 'scratch.log\n');
    }
    return out;
  };
  const git = g.options.git;
  let reset = false;
  g.options.git = { ...git, resetTo: async (...args) => { await git.resetTo(...args); reset = true; } };
  g.options.integrity = integrity.withGit(g.options.git, golden.crashFs(g.worktree, () => reset, crash));
  await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
  g.git = git;
  g.loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  return g;
}

const read = (g, p) => (existsSync(join(g.worktree, p)) ? readFileSync(join(g.worktree, p), 'utf8') : null);
const restoredFiles = (g) => ({
  '.claude/.gitignore': read(g, '.claude/.gitignore'),
  '.claude/settings.local.json': read(g, '.claude/settings.local.json'),
  'test/owner.test.mjs': read(g, 'test/owner.test.mjs'),
});

// The worktree and record a finished restore leaves.
function assertRestored(g, rec) {
  assert.deepEqual(restoredFiles(g), RESTORED);
  assert.equal(read(g, '.claude/agent.json'), null, 'the extra is removed');
  assert.equal(read(g, 'scratch.log'), 'agent log\n', 'an ignored file outside the rollback is untouched');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.deepEqual(rec.history.map((h) => h.kind), ['integrity violation']);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
}

// A case each, as golden.setup restores its process seams when its own test ends.
for (const [name, crash] of Object.entries(RESTORE_CRASHES)) {
  test(`an interrupted restore resumes from mixed left, absent and baseline files: crash ${name}`, async (t) => {
    const g = await crashedRestore(t, crash);
    assert.equal(await reconcile.resets(g.loaded, { git: g.git }), 'continue');
    assertRestored(g, g.loaded);
    assert.equal(await reconcile.resets(g.loaded, { git: g.git }), 'continue', 'a further Reconciliation');
    assertRestored(g, g.loaded);
  });
}

test('a second crash during restore replay remains resumable', async (t) => {
  const g = await crashedRestore(t, RESTORE_CRASHES['after deleting an extra']);
  const crashing = integrity.withGit(g.git, golden.crashFs(g.worktree, () => true, { op: 'writeFile', n: 1, after: true }));
  await assert.rejects(reconcile.resets(g.loaded, { git: g.git, integrity: crashing }), (err) => err instanceof interpreter.CrashError);
  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(resetEntries(loaded), ['intent']);
  assert.equal(await reconcile.resets(loaded, { git: g.git }), 'continue');
  assertRestored(g, loaded);
  assert.equal(await reconcile.resets(loaded, { git: g.git }), 'continue', 'a further Reconciliation');
  assertRestored(g, loaded);
});

test('unknown ignored contents hold a partial restore without changing files', async (t) => {
  const g = await crashedRestore(t, RESTORE_CRASHES['after removing a destination before its rewrite']);
  writeFileSync(join(g.worktree, '.claude', 'settings.local.json'), '{"human":true}\n');
  const paths = [...Object.keys(RESTORED), '.claude/agent.json', 'scratch.log'];
  const before = paths.map((p) => read(g, p));

  assert.equal(await reconcile.resets(g.loaded, { git: g.git }), 'held');
  assert.deepEqual(paths.map((p) => read(g, p)), before, 'nothing is restored or removed');
  assert.deepEqual(g.loaded.history, []);
  assert.deepEqual(resetEntries(g.loaded), ['intent']);
});

test('restored non-ignored baseline files are recognised at admission', async (t) => {
  const g = await crashedRestore(t, RESTORE_CRASHES['after the final write before evidence']);
  assert.equal(read(g, 'test/owner.test.mjs'), RESTORED['test/owner.test.mjs'], 'the untracked test is back');
  assert.equal(await reconcile.dirtyState(g.loaded, { git: g.git, worktree: g.worktree }), null);
  writeFileSync(join(g.worktree, 'notes.txt'), 'mine\n');
  const held = await reconcile.dirtyState(g.loaded, { git: g.git, worktree: g.worktree });
  assert.match(held?.stat ?? '', /notes\.txt \(untracked\)/, 'an unrelated untracked addition still holds');
});
