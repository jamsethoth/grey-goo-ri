import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as commit from '../../lib/effects/commit.ts';
import * as marker from '../../lib/marker.ts';
import * as effectFixture from '../support/effect-fixture.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

// A change staged in the worktree, and the commit of it the Action intends.
async function staged(given: Fixture, actionMarker: string): Promise<commit.Payload> {
  given.write('lib/add.mjs', 'export const add = (a, b) => a + b;\n');
  await given.git.stageAll(given.worktree);
  return {
    message: `feat: add\n\n${marker.markerTrailer(actionMarker)}`,
    tree: await given.git.writeTree(given.worktree),
    parent: await given.git.headSha(given.worktree),
  };
}

for (const redo of [false, true]) {
  test(`a commit made${redo ? ' again' : ''}, then looked for, is found on its parent and tree`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    const actionMarker = given.markerOf('commit');
    const payload = await staged(given, actionMarker);
    const evidence = await commit.effect.perform(given.context, payload, { redo });
    const head = await given.git.headSha(given.worktree);
    assert.notEqual(head, payload.parent);
    assert.deepEqual(evidence, { sha: head });
    assert.deepEqual(await given.lookedFor(given.intent(commit.effect, actionMarker, payload)), {
      status: 'found',
      evidence: { sha: head },
    });
  });
}

test('a commit not made is absent while the branch is at its parent and its tree is there', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const actionMarker = given.markerOf('commit');
  const payload = await staged(given, actionMarker);
  assert.deepEqual(await given.lookedFor(given.intent(commit.effect, actionMarker, payload)), { status: 'absent' });
});

// The states a human leaves: the commit amended onto another tree, or another commit on top of the parent.
const TAMPERED: [string, (given: Fixture, payload: commit.Payload) => Promise<unknown>, RegExp][] = [
  [
    'a commit carrying its marker on another tree',
    async (given, payload) => {
      await commit.effect.perform(given.context, payload, { redo: false });
      given.write('lib/other.mjs', 'export const other = 1;\n');
      await given.git.stageAll(given.worktree);
      return given.fixture.fakeGit!.amend(given.worktree, payload.message);
    },
    /carries the Action Marker .* but not the intended parent and tree/,
  ],
  [
    'a commit not made with the branch moved off its parent',
    async (given) => given.fixture.fakeGit!.commit(given.worktree, 'a human commit'),
    /was not made and the branch is no longer at its intended parent/,
  ],
];
for (const [state, tamper, reason] of TAMPERED) {
  test(`${state} conflicts`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    const actionMarker = given.markerOf('commit');
    const payload = await staged(given, actionMarker);
    await tamper(given, payload);
    const found = await given.lookedFor(given.intent(commit.effect, actionMarker, payload));
    assert.equal(found.status, 'conflicting');
    assert.match((found as { reason: string }).reason, reason);
  });
}

test("a worktree at the commit's parent with its tree staged proves the open commit; no other does", async (t) => {
  const given = await effectFixture.effectFixture(t);
  const actionMarker = given.markerOf('commit');
  const entry = given.intent(commit.effect, actionMarker, await staged(given, actionMarker));
  assert.equal(await given.proven(entry), true);
  given.write('lib/add.mjs', 'export const add = (a, b) => a - b;\n');
  assert.equal(await given.proven(entry), false);
});

// A commit with nothing to commit saves a null sha: it moved nothing.
test('the last commit gg made is the last commit evidence saved with a sha', async (t) => {
  const given = await effectFixture.effectFixture(t);
  assert.equal(commit.lastCommit(given.executionRecord), undefined);
  const commits: [string, string | null][] = [
    ['gg:first', 'a'.repeat(40)],
    ['gg:second', 'b'.repeat(40)],
    ['gg:empty', null],
  ];
  for (const [actionMarker, sha] of commits) {
    given.database.intent(given.executionRecord, actionMarker, commit.effect.name, {
      message: '',
      tree: '',
      parent: '',
    });
    given.database.evidence(given.executionRecord, actionMarker, { sha });
  }
  given.database.intent(given.executionRecord, 'gg:push', 'push', { branch: 'b', sha: 'c'.repeat(40) });
  given.database.evidence(given.executionRecord, 'gg:push', { sha: 'c'.repeat(40) });
  assert.deepEqual(commit.lastCommit(given.executionRecord), { actionMarker: 'gg:second', sha: 'b'.repeat(40) });
});
