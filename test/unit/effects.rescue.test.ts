import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as effects from '../../lib/effects/index.ts';
import * as rescue from '../../lib/effects/rescue.ts';
import type * as integrity from '../../lib/integrity.ts';
import type * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import * as effectFixture from '../support/effect-fixture.ts';
import * as executionContext from '../support/execution-context.ts';

// A worktree snapshot a case never reads.
const UNREAD: integrity.WorktreeSnapshot = { head: '', index: '', tree: '' };

test("a rescue intent is found by its ref's commit, absent with no ref, a conflict on another commit", async (t) => {
  const fixture = await golden.fixture(t);
  const { git } = fixture.options.deps;
  const context = { executionRecord: fixture.executionRecord, git, issueLabels: [] };
  // The finder reads only the ref and the commit.
  const rescued = (commit: string) => ({ ref: 'refs/gg/rescue/abc', commit, tree: '', parent: '', left: UNREAD });
  const entry: writeAhead.WriteAheadEntry = {
    step: 'intent',
    actionMarker: 'gg:rescue',
    effect: 'rescue',
    payload: rescued(fixture.base),
    evidence: null,
    time: '',
  };
  assert.equal((await effects.findEffect(entry, context)).status, 'absent');
  await git.createRef!(fixture.worktree, 'refs/gg/rescue/abc', fixture.base);
  assert.deepEqual(await effects.findEffect(entry, context), {
    status: 'found',
    evidence: { ref: 'refs/gg/rescue/abc', commit: fixture.base },
  });
  const other = { ...entry, payload: rescued('f'.repeat(40)) };
  assert.equal((await effects.findEffect(other, context)).status, 'conflicting');
});

test('a Rescue Ref made, then looked for, is found, and made again over itself', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = { ref: 'refs/gg/rescue/abc', commit: given.fixture.base, tree: '', parent: '', left: UNREAD };
  for (const redo of [false, true])
    assert.deepEqual(await rescue.effect.perform(given.context, payload, { redo }), {
      ref: payload.ref,
      commit: payload.commit,
    });
  assert.deepEqual(await given.lookedFor(given.intent(rescue.effect, given.markerOf('rescue'), payload)), {
    status: 'found',
    evidence: { ref: payload.ref, commit: payload.commit },
  });
});

test('a Rescue Ref that holds another commit is never overwritten: the Ticket is held', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const other = given.fixture.fakeGit!.commit(given.worktree, 'another commit');
  await given.git.createRef(given.worktree, 'refs/gg/rescue/abc', other);
  const payload = { ref: 'refs/gg/rescue/abc', commit: given.fixture.base, tree: '', parent: '', left: UNREAD };
  const err = await executionContext.rejection(rescue.effect.perform(given.context, payload, { redo: false }));
  assert.ok(err instanceof effectErrors.EarlyTerminalError);
  assert.deepEqual(err.ending, {
    next: 'hold',
    name: 'rescue',
    reason: `Rescue Ref refs/gg/rescue/abc already holds ${other}, so nothing was overwritten or reset.`,
  });
  assert.equal(await given.git.refTarget(given.worktree, 'refs/gg/rescue/abc'), other);
});

test('a worktree as the rescue found it proves the open rescue, and a worktree changed since does not', async (t) => {
  const given = await effectFixture.effectFixture(t);
  given.write('lib/add.mjs', 'export const add = (a, b) => a + b;\n');
  const left = await given.context.integrity.snapshot(given.worktree);
  const entry = given.intent(rescue.effect, given.markerOf('rescue'), {
    ref: 'refs/gg/rescue/abc',
    commit: given.fixture.base,
    tree: '',
    parent: '',
    left,
  });
  assert.equal(await given.proven(entry), true);
  given.write('lib/add.mjs', 'export const add = (a, b) => a - b;\n');
  assert.equal(await given.proven(entry), false);
});

test('the open rescue is the ref and commit its intent names, until it completes', async (t) => {
  const given = await effectFixture.effectFixture(t);
  assert.equal(rescue.openRescue(given.executionRecord), null);
  const payload = { ref: 'refs/gg/rescue/abc', commit: given.fixture.base, tree: 't', parent: 'p', left: UNREAD };
  given.database.intent(given.executionRecord, 'gg:rescue', rescue.effect.name, payload);
  assert.deepEqual(rescue.openRescue(given.executionRecord), { ref: payload.ref, commit: payload.commit });
  given.database.complete(given.executionRecord, 'gg:rescue');
  assert.equal(rescue.openRescue(given.executionRecord), null);
});
