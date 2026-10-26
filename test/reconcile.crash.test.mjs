import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as marker from '../lib/marker.mjs';
import * as reconcile from '../lib/reconcile.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';
import {
  resetEntries, markerOf, stepsOf, commitMessages, remoteSha, withMarker, loadTicket, EFFECTS, POINTS, crashed,
} from './support/reconcile.mjs';

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
  const restore = golden.crashFs(t, g.worktree, () => reset, crash);
  await assert.rejects(interpreter.runExecution(g.options), (err) => err instanceof interpreter.CrashError);
  restore();
  g.git = git;
  g.loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  return g;
}

const read = (g, p) => (existsSync(join(g.worktree, p)) ? readFileSync(join(g.worktree, p), 'utf8') : null);

async function assertRestored(g, rec) {
  for (const [p, text] of Object.entries(RESTORED)) assert.equal(read(g, p), text, p);
  assert.equal(read(g, '.claude/agent.json'), null, 'the extra is removed');
  assert.equal(read(g, 'scratch.log'), 'agent log\n', 'an ignored file outside the rollback is untouched');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base);
  assert.deepEqual(rec.history.map((h) => h.kind), ['integrity violation']);
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
  assert.equal(await reconcile.resets(rec, { git: g.git }), 'continue');
  assert.equal(rec.history.length, 1, 'a further Reconciliation adds nothing');
  assert.deepEqual(resetEntries(rec), ['intent', 'evidence', 'complete']);
  for (const [p, text] of Object.entries(RESTORED)) assert.equal(read(g, p), text, `${p} after a further Reconciliation`);
}

test('an interrupted restore resumes from mixed left, absent and baseline files', async (t) => {
  // A subtest each, as golden.setup restores its process seams when its own test ends.
  for (const [name, crash] of Object.entries(RESTORE_CRASHES)) {
    await t.test(name, async (t) => {
      const g = await crashedRestore(t, crash);
      assert.equal(await reconcile.resets(g.loaded, { git: g.git }), 'continue');
      await assertRestored(g, g.loaded);
    });
  }
});

test('a second crash during restore replay remains resumable', async (t) => {
  const g = await crashedRestore(t, RESTORE_CRASHES['after deleting an extra']);
  const restore = golden.crashFs(t, g.worktree, () => true, { op: 'writeFile', n: 1, after: true });
  await assert.rejects(reconcile.resets(g.loaded, { git: g.git }), (err) => err instanceof interpreter.CrashError);
  restore();
  const loaded = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.deepEqual(resetEntries(loaded), ['intent']);
  assert.equal(await reconcile.resets(loaded, { git: g.git }), 'continue');
  await assertRestored(g, loaded);
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

// T18: crash-and-resume golden traces. Each side-effect Action of the one-Vertex Flow is crashed at one of three points
// by runExecution's test-only crashAt, then resumed by a second runExecution on a freshly loaded record.
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

for (const [action, effect] of Object.entries(EFFECTS)) {
  for (const [point, expect] of Object.entries(POINTS)) {
    test(expect.name(action), async (t) => {
      const g = await golden.setup(t, { git: 'real' });
      const { m, loaded } = await crashed(g, effect.at, point);
      assert.equal(effect.happened(g, m), expect.happened, `the crash came ${point}`);
      assert.deepEqual(stepsOf(loaded, m), expect.steps, `the log as the crash ${point} left it`);

      const result = await interpreter.runExecution({ ...g.options, record: loaded });
      assert.equal(result.outcome, 'done');
      const final = await loadTicket(g);
      assert.equal(final.state, 'done');
      assert.equal(g.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
      const acted = g.readEvents().filter((e) => e.type === 'action').map((e) => `${e.vertex}/${e.visit}/${e.phase}/${e.ordinal}/${e.attempt}`);
      assert.deepEqual(acted, [...new Set(acted)], 'one Action Event per Action');

      // One intent, one evidence and one completion per marker.
      for (const e of final.log.filter((x) => x.step === 'intent')) {
        assert.deepEqual(stepsOf(final, e.marker), ['intent', 'evidence', 'complete'], `${e.action} ${e.marker}`);
      }
      const intents = (name) => final.log.filter((e) => e.step === 'intent' && e.action === name);

      const messages = commitMessages(g);
      assert.equal(messages.length, intents('commit').length, 'no duplicate commit');
      for (const e of intents('commit')) {
        assert.equal(messages.filter((b) => b.includes(marker.markerTrailer(e.marker))).length, 1, e.marker);
      }
      assert.equal(remoteSha(g), golden.sh(g.worktree, 'rev-parse', 'HEAD'), 'the remote branch is at the last commit');

      assert.equal(g.gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length, 1, 'exactly one PR');
      const [upsert] = intents('pr-upsert');
      assert.ok(g.gh.pr().body.includes(marker.markerComment(upsert.marker)), 'the PR body carries the marker');
      assert.equal(sha256(g.gh.pr().body), upsert.payload.bodyHash, 'the PR body is the intended one');

      const done = markerOf(g.rec, ...EFFECTS.comment.at);
      const posted = withMarker(g.gh.comments.map((c) => c.body), done);
      assert.equal(posted.length, 1, 'exactly one comment with the marker');
      assert.equal(sha256(posted[0]), final.log.find((e) => e.marker === done && e.step === 'intent').payload.bodyHash);
    });
  }
}
