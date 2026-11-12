import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as comment from '../../lib/effects/comment.ts';
import * as marker from '../../lib/marker.ts';
import * as golden from '../support/golden.ts';
import * as effectFixture from '../support/effect-fixture.ts';

// A comment on the Ticket whose body carries `actionMarker`, as every comment Action renders it.
const onTicket = (actionMarker: string): comment.Payload => {
  const body = `A comment.\n${marker.markerComment(actionMarker)}`;
  return { target: { kind: 'issue', number: golden.TICKET }, body, bodyHash: config.sha256(body) };
};

test('a comment made, then looked for, is found by the marker in its body', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const actionMarker = given.markerOf('comment');
  const evidence = await comment.effect.perform(given.context, onTicket(actionMarker), { redo: false });
  assert.equal(given.fixture.gh.comments.length, 1, 'one comment posted');
  const [posted] = given.fixture.gh.comments;
  assert.equal(posted.number, golden.TICKET);
  assert.deepEqual(evidence, { id: posted.id });
  assert.deepEqual(await given.lookedFor(given.intent(comment.effect, actionMarker, onTicket(actionMarker))), {
    status: 'found',
    evidence: { id: posted.id },
  });
});

// A comment's finder cannot conflict: a comment carrying another marker is someone else's.
for (const [state, made] of [
  ['no comment made', false],
  ['only a comment carrying another marker', true],
] as const) {
  test(`a comment with ${state} is absent`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    if (made) await comment.effect.perform(given.context, onTicket(given.markerOf('other')), { redo: false });
    const actionMarker = given.markerOf('comment');
    assert.deepEqual(await given.lookedFor(given.intent(comment.effect, actionMarker, onTicket(actionMarker))), {
      status: 'absent',
    });
  });
}

test('the comments this Execution posted are the ids its comment evidence saved', async (t) => {
  const given = await effectFixture.effectFixture(t);
  given.database.intent(given.executionRecord, 'gg:comment', comment.effect.name, onTicket('gg:comment'));
  given.database.evidence(given.executionRecord, 'gg:comment', { id: 31 });
  given.database.intent(given.executionRecord, 'gg:pr', 'pr-upsert', {
    branch: 'b',
    title: '',
    body: '',
    bodyHash: '',
  });
  given.database.evidence(given.executionRecord, 'gg:pr', { id: 99 });
  assert.deepEqual(comment.postedIds(given.executionRecord), [31]);
});
