import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { subjects } from '../support/execution-reads.ts';
import {
  MAJOR,
  finding,
  fixed,
  prReviewComments,
  review,
  reviewFixture,
  reviewStopReason,
  reviewed,
  runReviewFlow,
} from '../support/review-flow.ts';
import * as gitShell from '../support/git-shell.ts';
import * as keys from '../support/keys.ts';

const RIGHT_ADD = 'export const add = (a, b) => a + b;\n';
const reviewKey = (visit: number) => keys.responseKey('reviewer', visit, 'review', 1);
const fixKey = (visit: number) => keys.responseKey('implementer-fix', visit, 'fix', 1);

test('a fix that changes an unnamed test is an integrity violation', async (t) => {
  const fixture = await runReviewFlow(
    t,
    {
      [reviewKey(1)]: reviewed(review('changes', [MAJOR])),
      [fixKey(1)]: fixed({
        'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n',
        'test/add.test.mjs': '// weakened\n',
      }),
    },
    { integrity: 'real', git: 'real' },
  );

  assert.equal(fixture.result.outcome, 'needs-human');
  const call = fixture.actionsAt('implementer-fix', 1, 'fix', 0)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.deepEqual(call!.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] },
  ]);
  assert.deepEqual(
    await subjects(fixture),
    ['test: Add two numbers (#15)', 'feat: Add two numbers (#15)'],
    'no fix commit',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), '', 'the fix edit is rolled back');
  assert.ok(!readFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'));
  const reason = reviewStopReason(fixture);
  assert.deepEqual(reason.decidedBy, { vertex: 'implementer-fix', visit: 1, action: 'fix', recovery: 0 });
  assert.equal(reason.outcome, 'integrity-violation');
});

test('a fix that changes a named test moves the immutability baseline', async (t) => {
  const testEdit = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const fixture = await runReviewFlow(
    t,
    {
      [reviewKey(1)]: reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
      [fixKey(1)]: fixed({ 'test/add.test.mjs': testEdit }),
      [reviewKey(2)]: reviewed(review('changes', [MAJOR])),
      // Leaves the test as fix 1 committed it: only a moved baseline lets this pass Test Immutability.
      [fixKey(2)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewKey(3)]: reviewed(review('ok')),
    },
    { integrity: 'real', git: 'fake' },
  );

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  const first = fixture.actionsAt('implementer-fix', 1, 'test', 0)[0];
  assert.equal(first?.outcome, 'ok', `fix visit 1: ${first?.rule}`);
  assert.equal(first!.integrityViolations, null, 'fix visit 1 has no violations');
  const second = fixture.actionsAt('implementer-fix', 2, 'test', 0)[0];
  assert.equal(second?.outcome, 'ok', `fix visit 2: ${second?.rule}`);
  assert.equal(second!.integrityViolations, null, 'fix visit 2 has no violations');
  assert.deepEqual(
    (await subjects(fixture)).map((subject) => subject.split(':')[0]),
    ['test', 'feat', 'fix', 'fix'],
  );
  assert.equal(readFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'utf8'), testEdit);
  const reviews = fixture.harness.calls.filter((call) => call.access === 'read-only');
  assert.equal(reviews.length, 3);
  assert.ok(
    !reviews[0].brief!.includes('## Test files changed since the red commit'),
    'nothing changed before the fix',
  );
  assert.ok(
    reviews[1].brief!.includes('## Test files changed since the red commit\n- test/add.test.mjs'),
    'the second review Brief lists the changed test',
  );
  assert.ok(
    reviews[2].brief!.includes('## Test files changed since the red commit\n- test/add.test.mjs'),
    'the third review Brief lists the changed test',
  );
});

test('a fix with no edits keeps the moved immutability baseline', async (t) => {
  const testEdit = "import { add } from '../lib/add.mjs';\n// covers negatives\n";
  const fixture = await reviewFixture(
    t,
    {
      [reviewKey(1)]: reviewed(review('changes', [finding('major', 'test/add.test.mjs', 'the test misses negatives')])),
      [fixKey(1)]: fixed({ 'test/add.test.mjs': testEdit }),
      [reviewKey(2)]: reviewed(review('changes', [MAJOR])),
      [fixKey(2)]: fixed({}),
      // A finding of its own, so the third review is not a repeat of the second.
      [reviewKey(3)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'add still ignores strings')])),
      [fixKey(3)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewKey(4)]: reviewed(review('ok')),
    },
    { integrity: 'real', git: 'fake' },
  );
  golden.configure(fixture, (configured) => {
    (configured.flows.golden.ticket.vertices.reviewer.route as Record<string, { max: number }>).changes.max = 3;
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  const checks = fixture
    .readEvents()
    .filter(
      (event): event is events.ActionEvent =>
        event.type === 'action' &&
        event.vertex === 'implementer-fix' &&
        event.action === 'test' &&
        event.recovery === 0,
    );
  assert.deepEqual(
    checks.map((event) => [event.visit, event.outcome]),
    [
      [1, 'ok'],
      [2, 'ok'],
      [3, 'ok'],
    ],
  );
});

test('a review that changes the tree is an integrity violation', async (t) => {
  const fixture = await runReviewFlow(
    t,
    {
      [reviewKey(1)]: reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
    },
    { integrity: 'real', git: 'real' },
  );

  assert.equal(fixture.result.outcome, 'needs-human');
  const call = fixture.actionsAt('reviewer', 1, 'review', 0)[0];
  assert.equal(call?.outcome, 'integrity-violation');
  assert.ok(
    (call!.integrityViolations as integrity.IntegrityViolation[]).some((violation) => violation.surface === 'tree'),
    JSON.stringify(call!.integrityViolations),
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), '', 'the reviewer edit is rolled back');
  // The reset checks the file out again, so core.autocrlf may give it CRLF line endings on Windows.
  assert.equal(readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8').replace(/\r\n/g, '\n'), RIGHT_ADD);
  assert.equal(prReviewComments(fixture).length, 0, 'no review comment after a violation');
  const reason = reviewStopReason(fixture);
  assert.deepEqual(reason.decidedBy, { vertex: 'reviewer', visit: 1, action: 'review', recovery: 0 });
  assert.equal(reason.outcome, 'integrity-violation');
  assert.match(fixture.gh.comments.at(-1)!.body, /\btree\b/);
});

test('a review on a workspace-write agent is still read-only', async (t) => {
  const fixture = await reviewFixture(
    t,
    {
      [reviewKey(1)]: reviewed(review('ok'), { 'lib/add.mjs': 'export const add = () => "reviewer edit";\n' }),
    },
    { integrity: 'real', git: 'real' },
  );
  golden.configure(fixture, (configured) => {
    configured.agents.reviewer!.access = 'workspace-write';
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  const [, , reviewCall] = fixture.harness.calls;
  assert.deepEqual(
    reviewCall!.schema,
    JSON.parse(fixture.files['schemas/review.schema.json'].bytes),
    'the review call',
  );
  assert.equal(reviewCall!.access, 'read-only', 'the Harness runs the review read-only');
});
