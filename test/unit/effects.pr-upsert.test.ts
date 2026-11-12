import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as prUpsert from '../../lib/effects/pr-upsert.ts';
import * as marker from '../../lib/marker.ts';
import * as effectFixture from '../support/effect-fixture.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

// The Ticket branch's PR, whose body carries `actionMarker`.
const intended = (given: Fixture, actionMarker: string): prUpsert.Payload => {
  const body = `The PR.\n${marker.markerComment(actionMarker)}`;
  return {
    branch: given.executionRecord.branch,
    base: 'main',
    title: 'Add two numbers',
    body,
    bodyHash: config.sha256(body),
  };
};

test('a PR upserted, then looked for, is found by the marker in its body, and its number kept', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const actionMarker = given.markerOf('pr');
  const evidence = await prUpsert.effect.perform(given.context, intended(given, actionMarker), { redo: false });
  const pr = given.fixture.gh.pr();
  assert.ok(pr, 'a PR was made');
  assert.deepEqual(evidence, { number: pr.number, url: pr.url });
  assert.equal(given.executionRecord.pr, pr.number);
  given.executionRecord.pr = null;
  assert.deepEqual(await given.lookedFor(given.intent(prUpsert.effect, actionMarker, intended(given, actionMarker))), {
    status: 'found',
    evidence: { number: pr.number, url: pr.url },
  });
  assert.equal(given.executionRecord.pr, pr.number, 'a PR found is kept on the record');
});

// A PR's finder cannot conflict: a body edited since is upserted again.
for (const [state, edit] of [
  ['no PR', null],
  ['a PR whose body was edited by hand', (body: string) => `${body}\nEdited.`],
] as const) {
  test(`a PR upsert with ${state} is absent`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    const actionMarker = given.markerOf('pr');
    if (edit) {
      await prUpsert.effect.perform(given.context, intended(given, actionMarker), { redo: false });
      const pr = given.fixture.gh.pr();
      assert.ok(pr, 'a PR was made');
      pr.body = edit(pr.body!);
    }
    assert.deepEqual(
      await given.lookedFor(given.intent(prUpsert.effect, actionMarker, intended(given, actionMarker))),
      {
        status: 'absent',
      },
    );
  });
}
