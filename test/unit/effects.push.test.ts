import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as push from '../../lib/effects/push.ts';
import * as effectFixture from '../support/effect-fixture.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

// The branch at its head, as the push Action intends it.
const intended = async (given: Fixture): Promise<push.Payload> => ({
  branch: given.executionRecord.branch,
  sha: await given.git.headSha(given.worktree),
});

test('a push made, then looked for, is found by its remote sha', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = await intended(given);
  assert.deepEqual(await push.effect.perform(given.context, payload, { redo: false }), { remoteSha: payload.sha });
  assert.equal(await given.git.remoteSha(given.worktree, payload.branch), payload.sha);
  assert.deepEqual(await given.lookedFor(given.intent(push.effect, given.markerOf('push'), payload)), {
    status: 'found',
    evidence: { remoteSha: payload.sha },
  });
});

test('a push not made is absent while the branch is at its sha', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = await intended(given);
  assert.deepEqual(await given.lookedFor(given.intent(push.effect, given.markerOf('push'), payload)), {
    status: 'absent',
  });
});

test('a push not made with the branch moved from its sha conflicts', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = await intended(given);
  const moved = given.fixture.fakeGit!.commit(given.worktree, 'a human commit');
  const found = await given.lookedFor(given.intent(push.effect, given.markerOf('push'), payload));
  assert.equal(found.status, 'conflicting');
  assert.match(
    (found as { reason: string }).reason,
    new RegExp(`was not made and ${given.executionRecord.branch} has moved from ${payload.sha} to ${moved}`),
  );
});

test('a push that origin does not hold at its sha afterwards fails, so it is not taken as made', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = await intended(given);
  const git = { ...given.git, remoteSha: async () => 'f'.repeat(40) };
  await assert.rejects(
    push.effect.perform({ ...given.context, git }, payload, { redo: false }),
    new RegExp(`origin has ${payload.branch} at f{40}, not the intended ${payload.sha}`),
  );
});
