import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import {
  WRONG_ADD, GREEN_FAIL_OUTPUT, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow, ticketComments, reviewStopReason,
} from '../support/interpreter.mjs';

test('test-fix after fix resumes the fix session', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': WRONG_ADD }),
    'implementer-fix/1/test-fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  }, {
    exec: {
      runShell: async (command, opts) => {
        const file = join(opts?.cwd ?? '', 'lib', 'add.mjs');
        if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
        return readFileSync(file, 'utf8').includes('a + b')
          ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
      },
    },
  });

  assert.equal(g.at('implementer-fix', 1, 'fix', 2)[0]?.rule, 'check-failed');
  const fixCall = g.at('implementer-fix', 1, 'fix', 1)[0];
  const testFix = g.at('implementer-fix', 1, 'test-fix', 1)[0];
  assert.ok(testFix, 'test-fix/1 runs after the failing Green Check');
  assert.equal(testFix.lineage, 'fix', 'test-fix descends from the fix Phase');
  const call = g.harness.calls.find((c) => c.marker.includes(':test-fix:'));
  assert.equal(call.resume, fixCall.sessionId, 'test-fix resumes the fix session');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT));
  assert.equal(g.result.outcome, 'done');
});

test('misscoped lands in replan with the diagnosis on ticket and epic', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const g = await reviewFlow(t, { 'reviewer/1/review/1': reviewed(review('misscoped', [], { diagnosis })) });
  g.gh.labels.add('gg:state:in-progress');
  g.result = await interpreter.runExecution(g.options);
  g.events = g.readEvents();

  assert.equal(g.result.outcome, 'replan');
  assert.equal(g.rec.state, 'replan');
  const end = g.events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'replan');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-replan'], 'needs-replan replaces in-progress, and needs-human is not added');

  const onTicket = ticketComments(g);
  assert.equal(onTicket.length, 1, 'the diagnosis comment carries the Terminal Reason, no second comment');
  assert.ok(onTicket[0].body.includes(diagnosis));
  const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.rec.epic);
  assert.equal(onEpic.length, 1, 'the diagnosis is posted on the epic');
  assert.ok(onEpic[0].body.includes(diagnosis));
  const reason = reviewStopReason(g);
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.outcome, 'misscoped');
  assert.ok(!reason.text.includes(diagnosis), 'agent text stays fenced, out of the Terminal Reason');
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX VISIT')).length, 0);
});
