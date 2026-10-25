import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as briefs from '../lib/briefs.mjs';
import * as golden from './support/golden.mjs';
import {
  WRONG_ADD, GREEN_FAIL_OUTPUT, neededHuman, finding, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow,
  prReviewComments, ticketComments, reviewStopReason,
} from './support/interpreter.mjs';

const RIGHT_ADD = 'export const add = (a, b) => a + b;\n';

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

test('a fix that changes an unnamed test is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n', 'test/add.test.mjs': '// weakened\n' }),
  }, { integrity: 'real' });

  assert.equal(g.result.outcome, 'needs-human');
  const check = g.at('implementer-fix', 1, 'fix', 2)[0];
  assert.equal(check?.outcome, 'integrity-violation');
  assert.deepEqual(check.violations, ['test/add.test.mjs']);
  assert.ok(!g.subjects().some((s) => s.startsWith('fix:')), 'no fix commit');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the fix edit is rolled back');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'));
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer-fix', visit: 1, phase: 'fix', ordinal: 2 });
  assert.equal(reason.outcome, 'integrity-violation');
});

test('a fix that changes a named test moves the immutability baseline', async (t) => {
  const TEST_EDIT = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
    'implementer-fix/1/fix/1': fixed({ 'test/add.test.mjs': TEST_EDIT }),
    'reviewer/2/review/1': reviewed(review('changes', [MAJOR])),
    // Leaves the test as fix 1 committed it: only a moved baseline lets this pass Test Immutability.
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/3/review/1': reviewed(review('ok')),
  }, { integrity: 'real' });

  assert.equal(g.result.outcome, 'done');
  for (const visit of [1, 2]) {
    const check = g.at('implementer-fix', visit, 'fix', 2)[0];
    assert.equal(check?.outcome, 'ok', `fix visit ${visit}: ${check?.rule}`);
    assert.ok(!check.violations, `fix visit ${visit} has no violations`);
  }
  assert.deepEqual(g.subjects().map((s) => s.split(':')[0]), ['test', 'feat', 'fix', 'fix']);
  assert.equal(readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8'), TEST_EDIT);
  const reviews = g.harness.calls.filter((c) => c.access === 'read-only');
  assert.equal(reviews.length, 3);
  assert.ok(!reviews[0].brief.includes('## Test files changed since the red commit'), 'nothing changed before the fix');
  for (const r of reviews.slice(1)) {
    assert.ok(r.brief.includes('## Test files changed since the red commit\n- test/add.test.mjs'), 'every later review Brief lists the changed test');
  }
});

test('a fix with no edits keeps the moved immutability baseline', async (t) => {
  const TEST_EDIT = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
    'implementer-fix/1/fix/1': fixed({ 'test/add.test.mjs': TEST_EDIT }),
    'reviewer/2/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/2/fix/1': fixed({}),
    'reviewer/3/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/3/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/4/review/1': reviewed(review('ok')),
  }, { integrity: 'real' });
  g.flow.ticket.vertices.reviewer.route.changes.max = 3;
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'done');
  const checks = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'implementer-fix' && e.phase === 'fix' && e.ordinal === 2);
  assert.deepEqual(checks.map((e) => [e.visit, e.outcome]), [[1, 'ok'], [2, 'ok'], [3, 'ok']]);
});

test('misscoped lands in replan with the diagnosis on ticket and epic', async (t) => {
  const diagnosis = 'The ticket asks add to both sum and concatenate.';
  const g = await reviewSetup(t, { 'reviewer/1/review/1': reviewed(review('misscoped', [], { diagnosis })) });

  assert.equal(g.result.outcome, 'replan');
  assert.equal(g.rec.state, 'replan');
  const end = g.events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'replan');
  const edit = g.gh.calls.map((c) => c.args.join(' '))
    .find((a) => a.startsWith(`issue edit ${golden.TICKET}`) && a.includes('--add-label gg:state:needs-replan'));
  assert.ok(edit, 'issue edit adding needs-replan');
  assert.ok(edit.includes('--remove-label gg:state:in-progress'));
  assert.ok(!neededHuman(g));

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
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX ROUND')).length, 0);
});

test('a review that changes the tree is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  }, { integrity: 'real' });

  assert.equal(g.result.outcome, 'needs-human');
  const call = g.at('reviewer', 1, 'review', 1)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(call.violations.some((v) => v.surface === 'tree'), JSON.stringify(call.violations));
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
  // The reset checks the file out again, so core.autocrlf may give it CRLF line endings on Windows.
  assert.equal(readFileSync(join(g.worktree, 'lib', 'add.mjs'), 'utf8').replace(/\r\n/g, '\n'), RIGHT_ADD);
  assert.equal(prReviewComments(g).length, 0, 'no review comment after a violation');
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'reviewer', visit: 1, phase: 'review', ordinal: 1 });
  assert.equal(reason.outcome, 'integrity-violation');
  assert.match(g.gh.comments.at(-1).body, /\btree\b/);
});

test('a review on a workspace-write agent is still read-only', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  }, { integrity: 'real' });
  g.flow.ticket.vertices.reviewer.agent.access = 'workspace-write';
  g.result = await interpreter.runExecution(g.options);
  const events = g.readEvents();

  assert.equal(g.result.outcome, 'needs-human');
  const reviewCall = g.harness.calls.find((c) => c.schema === briefs.REVIEW_SCHEMA);
  assert.equal(reviewCall.access, 'read-only', 'the Harness runs the review read-only');
  const call = events.find((e) => e.type === 'action' && e.vertex === 'reviewer' && e.phase === 'review' && e.ordinal === 1);
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(call.violations.some((v) => v.surface === 'tree'), JSON.stringify(call.violations));
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
});
