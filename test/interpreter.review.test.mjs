import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../lib/interpreter.mjs';
import * as record from '../lib/record.mjs';
import * as marker from '../lib/marker.mjs';
import * as checks from '../lib/checks.mjs';
import * as golden from './support/golden.mjs';
import {
  neededHuman, REVIEWER_PERSONA, finding, review, reviewed, fixed, MAJOR, reviewSetup, reviewFlow, prReviewComments,
  reviewStopReason,
} from './support/interpreter.mjs';

test('golden: a changes verdict routes into the fix vertex and back to review then done', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok', [finding('minor', 'lib/add.mjs', 'name the parameters')])),
  });

  assert.equal(g.result.outcome, 'done');
  const seq = (vertex, visit, phase, n) => Array.from({ length: n }, (_, i) => `${vertex}/${visit}/${phase}/${i + 1}`);
  assert.deepEqual(g.actions.map((e) => `${e.vertex}/${e.visit}/${e.phase}/${e.ordinal}`), [
    ...seq('implementer', 1, 'red', 3), ...seq('implementer', 1, 'green', 5),
    ...seq('reviewer', 1, 'review', 4),
    ...seq('implementer-fix', 1, 'fix', 5),
    ...seq('reviewer', 2, 'review', 4),
  ]);
  for (const e of g.actions) assert.equal(e.attempt, 1, `${e.vertex}/${e.phase}/${e.ordinal}`);
  assert.deepEqual(g.actions.filter((e) => e.vertex === 'reviewer').map((e) => e.procedure), Array(8).fill('review'));
  assert.deepEqual(g.actions.filter((e) => e.vertex === 'implementer-fix').map((e) => e.procedure), Array(5).fill('fix'));
  assert.equal(g.at('reviewer', 1, 'review', 1)[0].outcome, 'changes');
  assert.equal(g.at('reviewer', 1, 'review', 1)[0].rule, 'claim-route', 'a changes claim routes through claim-route');
  assert.equal(g.at('reviewer', 2, 'review', 1)[0].outcome, 'ok');

  // The review is a read-only call with the diff and the captured Red and Green Evidence in its Brief.
  const [review1, fix, review2] = g.harness.calls.slice(2);
  assert.equal(review1.access, 'read-only');
  assert.ok(review1.brief.includes('a + b'), 'the diff is in the review Brief');
  assert.ok(review1.brief.includes(JSON.stringify(golden.RED_OUTPUT)), 'the Red Evidence is in the review Brief');
  assert.ok(review1.brief.includes(JSON.stringify(golden.GREEN_OUTPUT)), 'the Green Evidence is in the review Brief');
  assert.equal(review1.personaBytes, REVIEWER_PERSONA);
  // fix/1 is a fresh Session whose Brief carries the review Findings.
  assert.equal(fix.resume, null, 'fix never resumes');
  assert.ok(fix.brief.includes(MAJOR.issue), 'the Findings are in the fix Brief');
  assert.equal(fix.access, 'workspace-write');
  assert.equal(g.at('implementer-fix', 1, 'fix', 1)[0].lineage, null);
  assert.equal(review2.access, 'read-only');

  assert.deepEqual(g.subjects().map((s) => s.split(':')[0]), ['test', 'feat', 'fix']);
  assert.match(golden.sh(g.worktree, 'log', '-1', '--format=%B'), /Feature-Flow-Stage: implementer-fix fake\/model-x\/high/);
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'), 'fix/4 pushed');

  const comments = prReviewComments(g);
  assert.equal(comments.length, 2, 'two review comments on the PR');
  for (const c of comments) assert.match(c.body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.match(g.gh.pr().body, /^\| reviewer \| fake \| model-r \| high \| /m, 'the PR body carries the reviewer provenance row');
  assert.equal(g.gh.pr().isDraft, false);

  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 1);
  assert.deepEqual(g.rec.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
  assert.deepEqual(g.rec.outputs.reviews.map((r) => [r.vertex, r.visit]), [['reviewer', 1], ['reviewer', 2]]);
  assert.equal(g.events.at(-1).type, 'ticket_end');
  assert.equal(g.events.at(-1).outcome, 'done');
});

test('a restart at the review-to-fix boundary runs the pending fix with the saved edge count', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('changes', [MAJOR])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });
  g.flow.ticket.vertices.reviewer.route.changes.max = 1;
  // Before the fix Attempt's intent: one interrupted after it would be held instead.
  const fix = marker.formatMarker({ execution: g.rec.execution, vertex: 'implementer-fix', visit: 1, phase: 'fix', ordinal: 1, run: g.rec.run, attempt: 1 });
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: fix, point: 'before-intent' } }), /crash/);
  const saved = await record.load(g.commonDir, 'ticket', golden.TICKET);
  assert.equal(saved.traversals['reviewer->implementer-fix:changes'], 1);
  assert.equal(saved.cursor.vertex, 'implementer-fix');

  const before = g.harness.calls.length;
  const result = await interpreter.runExecution({ ...g.options, record: saved });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(g.harness.calls.slice(before).map((c) => (c.brief.startsWith('FIX ROUND') ? 'fix' : c.access)), ['fix', 'read-only'],
    'the restart runs the pending fix, then review, not the entry');
  assert.equal(saved.traversals['reviewer->implementer-fix:changes'], 1);
  assert.deepEqual(saved.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
});

test('two reviewer vertices keep their own sessions and provenance rows', async (t) => {
  const g = await reviewFlow(t, {
    'reviewer/1/review/1': reviewed(review('ok')),
    'reviewer-2/1/review/1': reviewed(review('ok')),
  });
  const { vertices } = g.flow.ticket;
  vertices.reviewer.route = { ...vertices.reviewer.route, ok: 'reviewer-2' };
  vertices['reviewer-2'] = { ...structuredClone(vertices.reviewer), route: { ...vertices.reviewer.route, ok: 'done' } };
  vertices['reviewer-2'].agent.model = 'model-s';
  g.result = await interpreter.runExecution(g.options);

  assert.equal(g.result.outcome, 'done');
  assert.ok(g.rec.sessions['reviewer/1/review'] && g.rec.sessions['reviewer-2/1/review'], JSON.stringify(Object.keys(g.rec.sessions)));
  assert.match(g.gh.pr().body, /^\| reviewer \| fake \| model-r \| high \| /m, 'the first reviewer row survives');
  assert.match(g.gh.pr().body, /^\| reviewer-2 \| fake \| model-s \| high \| /m);
});

test('the changes edge exhausts after max traversals to needs-human', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
    'reviewer/2/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'second problem')])),
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // two\n' }),
    'reviewer/3/review/1': reviewed(review('changes', [finding('major', 'lib/add.mjs', 'third problem')])),
  });

  assert.equal(g.result.outcome, 'needs-human');
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 2, 'two changes verdicts traverse the edge twice');
  assert.equal(g.rec.visits['implementer-fix'], 2);
  assert.equal(g.rec.visits.reviewer, 3);
  assert.equal(g.harness.calls.filter((c) => c.brief.startsWith('FIX ROUND')).length, 2, 'no third fix call');
  assert.ok(!g.actions.some((e) => e.vertex === 'implementer-fix' && e.visit === 3));
  const third = g.actions.filter((e) => e.vertex === 'reviewer' && e.visit === 3);
  assert.ok(third.some((e) => e.exhausted === true), 'the deciding Action Event records exhausted');
  assert.ok(!g.actions.filter((e) => e.vertex === 'reviewer' && e.visit < 3).some((e) => e.exhausted), 'only the third review exhausts');
  assert.ok(neededHuman(g));

  const reason = reviewStopReason(g);
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.decidedBy.visit, 3);
  assert.equal(reason.outcome, 'changes');
});

test('review ok without evidence is changes through the review-pass check', async (t) => {
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('ok', [finding('blocker', 'lib/add.mjs', 'add drops the second argument')])),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => b + a;\n' }),
    'reviewer/2/review/1': reviewed(review('ok')),
  });

  const decided = g.actions.filter((e) => e.vertex === 'reviewer' && e.visit === 1 && e.check === 'review-pass');
  assert.equal(decided.length, 1, 'review-pass is evaluated once on the Structured Response');
  assert.equal(decided[0].rule, 'check-failed');
  assert.equal(decided[0].outcome, 'changes');
  assert.equal(decided[0].signals.claim.claim, 'ok', 'the agent claimed ok');
  assert.equal(decided[0].signals.checks.find((c) => c.name === 'review-pass').passed, false);
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 1, 'the changes edge is taken');
  assert.equal(g.result.outcome, 'done');
});

test('a repeated findings hash is flagged', async (t) => {
  const same = [MAJOR, finding('major', 'test/add.test.mjs', 'the test   misses negatives on line 3')];
  const reworded = [finding('major', 'test/add.test.mjs', 'the test misses negatives on line 9'), { ...MAJOR, issue: 'add ignores non-number input at line 7' }];
  const g = await reviewSetup(t, {
    'reviewer/1/review/1': reviewed(review('changes', same)),
    'implementer-fix/1/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // tried\n' }),
    'reviewer/2/review/1': reviewed(review('changes', reworded)),
    'implementer-fix/2/fix/1': fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // again\n' }),
    'reviewer/3/review/1': reviewed(review('ok')),
  });

  const [first, second] = g.rec.outputs.reviews;
  assert.deepEqual([first.vertex, first.visit, second.vertex, second.visit], ['reviewer', 1, 'reviewer', 2]);
  assert.equal(first.findingsHash, checks.findingsHash(same));
  assert.equal(second.findingsHash, first.findingsHash, 'normalised Findings hash the same');
  const hashed = (visit) => g.at('reviewer', visit, 'review', 2)[0];
  assert.notEqual(hashed(1).repeat, true, 'the first review is not a repeat');
  assert.equal(hashed(2).repeat, true, 'the second review is flagged as a repeat');
  assert.equal(hashed(2).outcome, 'changes', 'repeat is not routed in this slice');
  assert.equal(g.rec.traversals['reviewer->implementer-fix:changes'], 2);
  assert.equal(g.result.outcome, 'done');
});
