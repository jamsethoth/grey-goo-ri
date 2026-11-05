import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as addSuite from '../support/add-suite.ts';
import * as golden from '../support/golden.ts';
import { GREEN_FAIL_OUTPUT } from '../support/add-suite.ts';
import { WRONG_ADD } from '../support/golden-run.ts';
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
  const g = await runReviewFlow(
    t,
    {
      'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
      'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': WRONG_ADD }),
      'implementer-fix/1/recover/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n' }),
      'reviewer/2/review/1': reviewed(review('ok')),
    },
    // The suite passes only once lib/add.mjs adds, so the wrong fix fails its Green Check.
    { exec: addSuite.addSuite({ worktree: '', checksSum: true }) },
  );

  assert.deepEqual(g.actionsAt('implementer-fix', 1, 'test', 0)[0]?.rule, { table: 'fixed', row: 'recover' });
  const fixCall = g.actionsAt('implementer-fix', 1, 'fix', 0)[0];
  const testFix = g.actionsAt('implementer-fix', 1, 'fix', 1)[0];
  assert.ok(testFix, 'the recovery pass runs after the failing Green Check');
  assert.equal(testFix.sessionLineage, 'fix', 'the recovery pass resumes the fix Phase');
  const call = g.harness.calls.find(
    (c) => c.marker === golden.markerOf(g.executionRecord, 'implementer-fix', 1, 'fix', 1),
  );
  assert.equal(call.resume, fixCall.sessionId, 'the recovery pass resumes the fix session');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT));
  assert.equal(g.result.outcome, 'ready-for-qa');
});

test('misscoped lands in replan with the diagnosis on ticket and epic', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const g = await reviewFixture(t, { 'reviewer/1/review/1': reviewed(review('misscoped', [], { diagnosis })) });
  g.gh.labels.add('gg:state:in-progress');
  const result = await interpreter.runExecution(g.options);
  const events = g.readEvents();

  assert.equal(result.outcome, 'needs-replan');
  assert.equal(g.executionRecord.state, 'needs-replan');
  const end = events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'needs-replan');
  assert.deepEqual(
    [...g.gh.labels],
    ['gg:state:needs-replan'],
    'needs-replan replaces in-progress, and needs-human is not added',
  );

  const onTicket = ticketComments(g);
  assert.equal(onTicket.length, 1, 'the diagnosis comment carries the Terminal Reason, no second comment');
  assert.ok(onTicket[0].body.includes(diagnosis));
  const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.executionRecord.epic);
  assert.equal(onEpic.length, 1, 'the diagnosis is posted on the epic');
  assert.ok(onEpic[0].body.includes(diagnosis));
  const reason = reviewStopReason({ ...g, events });
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.outcome, 'misscoped');
  assert.ok(!reason.text.includes(diagnosis), 'agent text stays fenced, out of the Terminal Reason');
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX VISIT')).length, 0);
});
