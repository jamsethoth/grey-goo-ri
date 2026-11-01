import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import {
  finding, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow, prReviewComments, reviewStopReason, subjects,
} from '../support/interpreter.mjs';

const RIGHT_ADD = 'export const add = (a, b) => a + b;\n';

test('a fix that changes an unnamed test is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n', 'test/add.test.mjs': '// weakened\n' }),
  }, { integrity: 'real' });

  assert.equal(g.result.outcome, 'needs-human');
  const call = g.at('implementer-fix', 1, 'fix', 0)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.deepEqual(call.violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] }]);
  assert.deepEqual(await subjects(g), ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)'], 'no fix commit');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the fix edit is rolled back');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'));
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer-fix', visit: 1, action: 'fix', recovery: 0 });
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

  assert.equal(g.result.outcome, 'ready-for-qa');
  const first = g.at('implementer-fix', 1, 'test', 0)[0];
  assert.equal(first?.outcome, 'ok', `fix visit 1: ${first?.rule}`);
  assert.equal(first.violations, undefined, 'fix visit 1 has no violations');
  const second = g.at('implementer-fix', 2, 'test', 0)[0];
  assert.equal(second?.outcome, 'ok', `fix visit 2: ${second?.rule}`);
  assert.equal(second.violations, undefined, 'fix visit 2 has no violations');
  assert.deepEqual((await subjects(g)).map((s) => s.split(':')[0]), ['test', 'feat', 'fix', 'fix']);
  assert.equal(readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8'), TEST_EDIT);
  const reviews = g.harness.calls.filter((c) => c.access === 'read-only');
  assert.equal(reviews.length, 3);
  assert.ok(!reviews[0].brief.includes('## Test files changed since the red commit'), 'nothing changed before the fix');
  assert.ok(reviews[1].brief.includes('## Test files changed since the red commit\n- test/add.test.mjs'), 'the second review Brief lists the changed test');
  assert.ok(reviews[2].brief.includes('## Test files changed since the red commit\n- test/add.test.mjs'), 'the third review Brief lists the changed test');
});

test('a fix with no edits keeps the moved immutability baseline', async (t) => {
  const TEST_EDIT = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
    'implementer-fix/1/fix/1': fixed({ 'test/add.test.mjs': TEST_EDIT }),
    'reviewer/2/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/2/fix/1': fixed({}),
    // A finding of its own, so the third review is not a repeat of the second.
    'reviewer/3/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'add still ignores strings')])),
    'implementer-fix/3/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/4/review/1': reviewed(review('ok')),
  }, { integrity: 'real' });
  golden.configure(g, (c) => { c.flows.golden.ticket.vertices.reviewer.route.changes.max = 3; });
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'ready-for-qa');
  const checks = g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'implementer-fix' && e.action === 'test' && e.recovery === 0);
  assert.deepEqual(checks.map((e) => [e.visit, e.outcome]), [[1, 'ok'], [2, 'ok'], [3, 'ok']]);
});

test('a review that changes the tree is an integrity violation', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  }, { integrity: 'real' });

  assert.equal(g.result.outcome, 'needs-human');
  const call = g.at('reviewer', 1, 'review', 0)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(call.violations.some((v) => v.surface === 'tree'), JSON.stringify(call.violations));
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
  // The reset checks the file out again, so core.autocrlf may give it CRLF line endings on Windows.
  assert.equal(readFileSync(join(g.worktree, 'lib', 'add.mjs'), 'utf8').replace(/\r\n/g, '\n'), RIGHT_ADD);
  assert.equal(prReviewComments(g).length, 0, 'no review comment after a violation');
  const reason = reviewStopReason(g);
  assert.deepEqual(reason.decidedBy, { vertex: 'reviewer', visit: 1, action: 'review', recovery: 0 });
  assert.equal(reason.outcome, 'integrity-violation');
  assert.match(g.gh.comments.at(-1).body, /\btree\b/);
});

test('a review on a workspace-write agent is still read-only', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
  }, { integrity: 'real' });
  golden.configure(g, (c) => { c.agents.reviewer.access = 'workspace-write'; });
  g.result = await interpreter.runExecution(g.options);

  assert.equal(g.result.outcome, 'needs-human');
  const [, , reviewCall] = g.harness.calls;
  assert.deepEqual(reviewCall.schema, JSON.parse(g.files['schemas/review.schema.json'].bytes), 'the review call');
  assert.equal(reviewCall.access, 'read-only', 'the Harness runs the review read-only');
});
