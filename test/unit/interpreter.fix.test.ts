import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as addSuite from '../support/add-suite.ts';
import * as golden from '../support/golden.ts';
import { GREEN_FAIL_OUTPUT } from '../support/add-suite.ts';
import { WRONG_ADD } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import {
  MAJOR,
  fixed,
  review,
  reviewFixture,
  reviewStopReason,
  reviewed,
  runReviewFlow,
  ticketComments,
} from '../support/review-flow.ts';

test('a recovery pass after fix resumes the fix session', async (t) => {
  const fixture = await runReviewFlow(
    t,
    {
      [keys.responseKey({ vertex: 'reviewer', visit: 1, action: 'review' })]: reviewed(review('changes', [MAJOR])),
      [keys.responseKey({ vertex: 'implementer-fix', visit: 1, action: 'fix' })]: fixed({ 'lib/add.mjs': WRONG_ADD }),
      [keys.responseKey({ vertex: 'implementer-fix', visit: 1, action: 'fix', recovery: 1 })]: fixed({
        'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n',
      }),
      [keys.responseKey({ vertex: 'reviewer', visit: 2, action: 'review' })]: reviewed(review('ok')),
    },
    // The suite passes only once lib/add.mjs adds, so the wrong fix fails its Green Check.
    { exec: addSuite.addSuite({ worktree: '', checksSum: true }) },
  );

  assert.deepEqual(fixture.actionsAt('implementer-fix', 1, 'test', 0)[0]?.rule, { table: 'fixed', row: 'recover' });
  const fixCall = fixture.actionsAt('implementer-fix', 1, 'fix', 0)[0] as events.AgentActionEvent;
  const testFix = fixture.actionsAt('implementer-fix', 1, 'fix', 1)[0] as events.AgentActionEvent | undefined;
  assert.ok(testFix, 'the recovery pass runs after the failing Green Check');
  assert.equal(testFix.sessionLineage, 'fix', 'the recovery pass resumes the fix Phase');
  const call = fixture.harness.calls.find(
    (harnessCall) => harnessCall.marker === golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'fix', 1),
  )!;
  assert.equal(call.resume, fixCall.sessionId, 'the recovery pass resumes the fix session');
  assert.ok(call.brief!.includes(GREEN_FAIL_OUTPUT));
  assert.equal(fixture.result.outcome, 'ready-for-qa');
});

// A Session is keyed by its Vertex, Visit and Action, and a Visit pins its Agent and so its Harness, so a resumed call
// takes only a Session its own Action started: resume across Vertices or Harnesses cannot arise, and the validator
// has no Problem for it (ADR 0014, decision 3 of #429).
test('every resumed call resumes a Session its own Vertex, Visit and Action started', async (t) => {
  const fixture = await runReviewFlow(
    t,
    {
      [keys.responseKey({ vertex: 'reviewer', visit: 1, action: 'review' })]: reviewed(review('changes', [MAJOR])),
      [keys.responseKey({ vertex: 'implementer-fix', visit: 1, action: 'fix' })]: fixed({ 'lib/add.mjs': WRONG_ADD }),
      [keys.responseKey({ vertex: 'implementer-fix', visit: 1, action: 'fix', recovery: 1 })]: fixed({
        'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n',
      }),
      [keys.responseKey({ vertex: 'reviewer', visit: 2, action: 'review' })]: reviewed(review('ok')),
    },
    { exec: addSuite.addSuite({ worktree: '', checksSum: true }) },
  );
  const startedBy = new Map(
    fixture.actions
      .filter((event): event is events.AgentActionEvent => event.agent && event.recovery === 0 && event.attempt === 1)
      .map((event) => [event.sessionId, `${event.vertex}/${event.visit}/${event.action}`]),
  );
  const resumed = fixture.harness.calls.filter((harnessCall) => harnessCall.resume != null);
  assert.ok(resumed.length > 0, 'the recovery pass resumes a Session');
  assert.deepEqual(
    resumed.map((harnessCall) => startedBy.get(harnessCall.resume!)),
    resumed.map((harnessCall) => {
      const parts = marker.partsOf(harnessCall.marker);
      return `${parts.vertex}/${parts.visit}/${parts.action}`;
    }),
  );
});

test('misscoped lands in replan with the diagnosis on ticket and epic', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const fixture = await reviewFixture(t, {
    [keys.responseKey({ vertex: 'reviewer', visit: 1, action: 'review' })]: reviewed(
      review('misscoped', [], { diagnosis }),
    ),
  });
  fixture.gh.labels.add('gg:state:in-progress');
  const result = await interpreter.runExecution(fixture.options);
  const ran = fixture.readEvents();

  assert.equal(result.outcome, 'needs-replan');
  assert.equal(fixture.executionRecord.state, 'needs-replan');
  const end = ran.at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-replan');
  assert.deepEqual(
    [...fixture.gh.labels],
    ['gg:state:needs-replan'],
    'needs-replan replaces in-progress, and needs-human is not added',
  );

  const onTicket = ticketComments(fixture);
  assert.equal(onTicket.length, 1, 'the diagnosis comment carries the Terminal Reason, no second comment');
  assert.ok(onTicket[0]!.body.includes(diagnosis));
  const onEpic = fixture.gh.comments.filter(
    (comment) => comment.target === 'issue' && comment.number === fixture.executionRecord.epic,
  );
  assert.equal(onEpic.length, 1, 'the diagnosis is posted on the epic');
  assert.ok(onEpic[0]!.body.includes(diagnosis));
  const reason = reviewStopReason({ ...fixture, result, events: ran });
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.outcome, 'misscoped');
  assert.ok(!reason.text.includes(diagnosis), 'agent text stays fenced, out of the Terminal Reason');
  assert.equal(fixture.harness.calls.filter((harnessCall) => harnessCall.brief!.startsWith('FIX VISIT')).length, 0);
});
