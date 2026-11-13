import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import * as marker from '../../lib/marker.ts';
import * as checks from '../../lib/checks.ts';
import type * as visit from '../../lib/visit.ts';
import * as golden from '../support/golden.ts';
import { branchMessages, headSha, originSha } from '../support/execution-reads.ts';
import {
  MAJOR,
  REVIEWER_PERSONA,
  finding,
  fixed,
  prReviewComments,
  review,
  reviewFixture,
  reviewStopReason,
  reviewed,
  runReviewFlow,
  type ReviewRun,
} from '../support/review-flow.ts';
import * as actionSignals from '../support/action-signals.ts';
import * as keys from '../support/keys.ts';
import { actionById } from '../support/procedure-actions.ts';

const reviewKey = (visit: number, attempt = 1) => keys.responseKey('reviewer', visit, 'review', attempt);
const fixKey = (vertex: string, visit: number) => keys.responseKey(vertex, visit, 'fix', 1);
// A Vertex's route as a case edits it: the configuration declares a Vertex's keys as unknown.
const routeOf = (vertex: Record<string, unknown>) => vertex.route as Record<string, unknown>;

// The Actions of a changes verdict, its fix and an ok review, in Event order.
const CHANGES_THEN_OK = [
  'red/1/red/0',
  'red/1/red-check/0',
  'red/1/commit/0',
  'green/1/green/0',
  'green/1/test/0',
  'green/1/commit/0',
  'green/1/push/0',
  'green/1/pr/0',
  'reviewer/1/review/0',
  'reviewer/1/review-pass/0',
  'reviewer/1/repeat/0',
  'reviewer/1/comment/0',
  'reviewer/1/pr/0',
  'implementer-fix/1/fix/0',
  'implementer-fix/1/test/0',
  'implementer-fix/1/commit/0',
  'implementer-fix/1/push/0',
  'implementer-fix/1/pr/0',
  'reviewer/2/review/0',
  'reviewer/2/review-pass/0',
  'reviewer/2/repeat/0',
  'reviewer/2/comment/0',
  'reviewer/2/pr/0',
  'publish/1/test/0',
  'publish/1/pr/0',
  'publish/1/pr-ready/0',
];

type Call = ReviewRun['harness']['calls'][number];

// The two reviews and the fix between them, as the harness was called.
function assertReviewAndFixCalls(fixture: ReviewRun) {
  // The review is a read-only call with the diff and the captured Red and Green Evidence in its Brief.
  const [review1, fix, review2] = fixture.harness.calls.slice(2) as [Call, Call, Call];
  assert.equal(review1.access, 'read-only');
  assert.ok(review1.brief!.includes('a + b'), 'the diff is in the review Brief');
  assert.ok(review1.brief!.includes(golden.RED_OUTPUT), 'the Red Evidence is in the review Brief');
  assert.ok(review1.brief!.includes(golden.GREEN_OUTPUT), 'the Green Evidence is in the review Brief');
  assert.equal(review1.personaBytes, REVIEWER_PERSONA);
  // fix/1 is a fresh Session whose Brief carries the review Findings.
  assert.equal(fix.resume, null, 'fix never resumes');
  assert.ok(fix.brief!.includes(MAJOR.issue), 'the Findings are in the fix Brief');
  assert.equal(fix.access, 'workspace-write');
  assert.equal((fixture.actionsAt('implementer-fix', 1, 'fix', 0)[0] as events.AgentActionEvent).sessionLineage, null);
  assert.equal(review2.access, 'read-only');
}

// The fix's commit is pushed, and each review commented on the PR.
async function assertFixPushedAndCommented(fixture: ReviewRun) {
  const messages = await branchMessages(fixture);
  assert.deepEqual(
    messages.map((message) => message.split(':')[0]),
    ['test', 'feat', 'fix'],
  );
  assert.match(messages.at(-1)!, /Gg-Vertex: implementer-fix fake\/model-x\/high/);
  assert.equal(await originSha(fixture), await headSha(fixture), 'fix/4 pushed');

  const comments = prReviewComments(fixture);
  assert.equal(comments.length, 2, 'two review comments on the PR');
  assert.match(comments[0].body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.match(comments[1].body, /^<!-- gg-action gg:\S+ -->$/m);
  assert.match(
    fixture.gh.pr()!.body!,
    /^\| reviewer \| fake \| model-r \| high \| /m,
    'the PR body carries the reviewer provenance row',
  );
  assert.equal(fixture.gh.pr()!.isDraft, false);
}

test(
  'golden: a changes verdict routes into the fix vertex and back to review, ' + 'then publish to ready-for-qa',
  async (t) => {
    const fixture = await runReviewFlow(t, {
      [reviewKey(1)]: reviewed(review('changes', [MAJOR])),
      [fixKey('implementer-fix', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewKey(2)]: reviewed(review('ok', [finding('minor', 'lib/add.mjs', 'name the parameters')])),
    });

    assert.equal(fixture.result.outcome, 'ready-for-qa');
    assert.deepEqual(
      fixture.actions.map((event) => `${event.vertex}/${event.visit}/${event.action}/${event.recovery}`),
      CHANGES_THEN_OK,
    );
    assert.deepEqual(
      fixture.actions.filter((event) => event.attempt !== 1),
      [],
      'every Action is its first Attempt',
    );
    assert.deepEqual(
      fixture.actions.filter((event) => event.vertex === 'reviewer').map((event) => event.procedure),
      ['review', 'review', 'review', 'review', 'review', 'review', 'review', 'review', 'review', 'review'],
    );
    assert.deepEqual(
      fixture.actions.filter((event) => event.vertex === 'implementer-fix').map((event) => event.procedure),
      ['fix', 'fix', 'fix', 'fix', 'fix'],
    );
    assert.equal(fixture.actionsAt('reviewer', 1, 'review', 0)[0].outcome, 'changes');
    assert.deepEqual(
      fixture.actionsAt('reviewer', 1, 'review', 0)[0].rule,
      { table: 'fixed', row: 'claimed' },
      'a changes claim is handed to the review tables',
    );
    assert.equal(fixture.actionsAt('reviewer', 2, 'review', 0)[0].outcome, 'ok');

    assertReviewAndFixCalls(fixture);

    await assertFixPushedAndCommented(fixture);

    assert.equal(fixture.executionRecord.traversals.get('reviewer->implementer-fix:changes'), 1);
    assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
      red: 1,
      green: 1,
      reviewer: 2,
      'implementer-fix': 1,
      publish: 1,
    });
    assert.deepEqual(
      fixture.executionRecord.outputs
        .filter((output) => output.action === 'repeat')
        .map((output) => [output.vertex, output.visit]),
      [
        ['reviewer', 1],
        ['reviewer', 2],
      ],
    );
    assert.equal(fixture.events.at(-1)!.type, 'ticket_end');
    assert.equal((fixture.events.at(-1) as events.TicketEndEvent).outcome, 'ready-for-qa');
  },
);

test('a restart at the review-to-fix boundary runs the pending fix with the saved edge count', async (t) => {
  const fixture = await reviewFixture(t, {
    [reviewKey(1)]: reviewed(review('changes', [MAJOR])),
    [fixKey('implementer-fix', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [reviewKey(2)]: reviewed(review('ok')),
  });
  golden.configure(fixture, (configured) => {
    (routeOf(configured.flows.golden.ticket.vertices.reviewer!).changes as { max: number }).max = 1;
  });
  // Before the fix Attempt's intent: one interrupted after it would be held instead.
  const fix = golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'fix');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: fix, point: 'before-intent' } }),
    (err: unknown) => err instanceof interpreter.CrashError,
  );
  const saved = record.load(fixture.commonDir, 'ticket', golden.TICKET)!;
  assert.equal(saved.traversals.get('reviewer->implementer-fix:changes'), 1);
  assert.equal(saved.cursor.vertex, 'implementer-fix');

  const before = fixture.harness.calls.length;
  const result = await interpreter.runExecution({ ...fixture.options, record: saved });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(
    fixture.harness.calls.slice(before).map((call) => (call.brief!.startsWith('FIX VISIT') ? 'fix' : call.access)),
    ['fix', 'read-only'],
    'the restart runs the pending fix, then review, not the entry',
  );
  assert.equal(saved.traversals.get('reviewer->implementer-fix:changes'), 1);
  assert.deepEqual(Object.fromEntries(saved.visits), {
    red: 1,
    green: 1,
    reviewer: 2,
    'implementer-fix': 1,
    publish: 1,
  });
});

test('two reviewer vertices keep their own sessions and provenance rows', async (t) => {
  const fixture = await reviewFixture(t, {
    [reviewKey(1)]: reviewed(review('ok')),
    [keys.responseKey('reviewer-2', 1, 'review', 1)]: reviewed(review('ok')),
  });
  golden.configure(fixture, (configured) => {
    const { vertices } = configured.flows.golden.ticket;
    routeOf(vertices.reviewer!).ok = 'reviewer-2';
    vertices['reviewer-2'] = {
      ...structuredClone(vertices.reviewer),
      model: 'model-s',
      route: { ...routeOf(vertices.reviewer!), ok: 'publish' },
    };
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa');
  assert.ok(
    fixture.executionRecord.sessions[keys.sessionKey({ vertex: 'reviewer', visit: 1, action: 'review' })] &&
      fixture.executionRecord.sessions[keys.sessionKey({ vertex: 'reviewer-2', visit: 1, action: 'review' })],
    JSON.stringify(Object.keys(fixture.executionRecord.sessions)),
  );
  assert.match(
    fixture.gh.pr()!.body!,
    /^\| reviewer \| fake \| model-r \| high \| /m,
    'the first reviewer row survives',
  );
  assert.match(fixture.gh.pr()!.body!, /^\| reviewer-2 \| fake \| model-s \| high \| /m);
});

test('the changes edge exhausts after max traversals to needs-human', async (t) => {
  const fixture = await runReviewFlow(t, {
    [reviewKey(1)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
    [fixKey('implementer-fix', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
    [reviewKey(2)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'second problem')])),
    [fixKey('implementer-fix', 2)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // two\n' }),
    [reviewKey(3)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'third problem')])),
  });

  assert.equal(fixture.result.outcome, 'needs-human');
  assert.equal(
    fixture.executionRecord.traversals.get('reviewer->implementer-fix:changes'),
    2,
    'two changes verdicts traverse the edge twice',
  );
  assert.equal(fixture.executionRecord.visits.get('implementer-fix'), 2);
  assert.equal(fixture.executionRecord.visits.get('reviewer'), 3);
  assert.equal(
    fixture.harness.calls.filter((call) => call.brief!.startsWith('FIX VISIT')).length,
    2,
    'no third fix call',
  );
  assert.deepEqual(
    fixture.actions.filter((event) => event.vertex === 'implementer-fix' && event.visit === 3),
    [],
    'no third fix Visit',
  );
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);

  const reason = reviewStopReason(fixture);
  assert.equal(reason.decidedBy.vertex, 'reviewer');
  assert.equal(reason.decidedBy.visit, 3);
  assert.equal(reason.outcome, 'changes');
  assert.equal(
    reason.text,
    'reviewer visit 3 completed every review Action with outcome changes, and its Edge to implementer-fix ' +
      'had used its Bound of 2 traversals, so the route ended at needs-human.',
  );
});

test('golden: a review ok without evidence routes as changes through the passed table', async (t) => {
  const fixture = await runReviewFlow(t, {
    [reviewKey(1)]: reviewed(review('ok', [finding('blocker', 'lib/add.mjs', 'add drops the second argument')])),
    [fixKey('implementer-fix', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => b + a;\n' }),
    [reviewKey(2)]: reviewed(review('ok')),
  });

  const checked = fixture.actionsAt('reviewer', 1, 'review-pass', 0);
  assert.equal(checked.length, 1, 'review-pass is evaluated once on the Structured Response');
  assert.equal(actionSignals.signalsOf(checked[0]).claim.token, 'ok', 'the agent claimed ok');
  assert.deepEqual(checked[0].signals.checks, [{ id: 'review-pass', kind: 'response', state: 'failed', tree: null }]);
  // No Claim requires review-pass (P5a), so the review still comments and updates the PR.
  assert.equal(checked[0].outcome, 'ok');
  assert.equal(fixture.actionsAt('reviewer', 1, 'comment', 0).length, 1);
  assert.equal(fixture.actionsAt('reviewer', 1, 'pr', 0).length, 1);
  // The passed table's only ok row needs review-pass passed, so the Visit routes by otherwise: changes.
  assert.equal(
    fixture.executionRecord.traversals.get('reviewer->implementer-fix:changes'),
    1,
    'the changes edge is taken',
  );
  assert.equal(fixture.result.outcome, 'ready-for-qa');
});

test('a repeated findings hash is flagged', async (t) => {
  const same = [MAJOR, finding('major', 'test/add.test.mjs', 'the test   misses negatives on line 3')];
  const reworded = [
    finding('major', 'test/add.test.mjs', 'the test misses negatives on line 9'),
    { ...MAJOR, issue: 'add ignores non-number input at line 7' },
  ];
  const fixture = await runReviewFlow(t, {
    [reviewKey(1)]: reviewed(review('changes', same)),
    [fixKey('implementer-fix', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // tried\n' }),
    [reviewKey(2)]: reviewed(review('changes', reworded)),
    [fixKey('senior-dev', 1)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // again\n' }),
    [reviewKey(3)]: reviewed(review('ok')),
  });

  const [first, second] = fixture.executionRecord.outputs.filter((output) => output.action === 'repeat') as [
    visit.ActionOutput,
    visit.ActionOutput,
  ];
  assert.deepEqual([first.vertex, first.visit, second.vertex, second.visit], ['reviewer', 1, 'reviewer', 2]);
  assert.equal(first.value.findingsHash, checks.findingsHash(same));
  assert.equal(second.value.findingsHash, first.value.findingsHash, 'normalised Findings hash the same');
  const hashed = (visitNumber: number) => fixture.actionsAt('reviewer', visitNumber, 'repeat', 0)[0];
  assert.deepEqual(
    hashed(1).signals.checks,
    [{ id: 'repeat', kind: 'repeat', state: 'passed', tree: null }],
    'the first review is not a repeat',
  );
  assert.deepEqual(
    hashed(2).signals.checks,
    [{ id: 'repeat', kind: 'repeat', state: 'failed', tree: null }],
    'the second review is a repeat',
  );
  assert.deepEqual(
    Object.fromEntries(fixture.executionRecord.traversals),
    { 'reviewer->implementer-fix:changes': 1, 'reviewer->senior-dev:repeat': 1 },
    'the repeat routes as repeat',
  );
  assert.equal(fixture.result.outcome, 'ready-for-qa');
});

test('the review lists the test files changed since red under the testPaths pinned at its Visit entry', async (t) => {
  const fixture = await reviewFixture(t, { [reviewKey(1)]: reviewed(review('ok')) });
  fixture.options.pinned.configuration.testPaths = ['test/**', 'lib/**'];
  // Test Immutability always passes here, and classifies what the Execution changed by the globs it is given.
  fixture.options.testImmutability = async (_cwd: string, _baseline: unknown, globs: string[]) => ({
    ok: true,
    changed: ['lib/add.mjs', 'test/add.test.mjs'].filter(checks.testPathMatcher(globs)),
  });
  // The live testPaths drop lib/** after the reviewer's Visit pinned them, just before its changed-test list is read.
  const { branchDiff } = fixture.options.deps.git;
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    branchDiff: (...args: Parameters<typeof branchDiff>) => {
      fixture.options.pinned.configuration.testPaths.splice(1);
      return branchDiff(...args);
    },
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(
    fixture.executionRecord.configurationSnapshot!.testPaths,
    ['test/**'],
    'publish, the last Visit, pinned the edited testPaths at its own entry',
  );
  const [, , reviewCall] = fixture.harness.calls;
  assert.equal(reviewCall!.access, 'read-only');
  assert.match(
    reviewCall!.brief!,
    /## Test files changed since the red commit\n- lib\/add\.mjs\n- test\/add\.test\.mjs\n/,
  );
});

test('the branch diff and changed test files are read for the review Brief and not again for its nudge', async (t) => {
  const fixture = await reviewFixture(t, {
    [reviewKey(1)]: reviewed(null),
    [reviewKey(1, 2)]: reviewed(review('ok')),
  });
  // Each read is tagged with how many harness calls came before it: 2 is the Green Check and the review Brief, 3 would
  // be the nudge.
  const reads: string[] = [];
  const { branchDiff } = fixture.options.deps.git;
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    branchDiff: (...args: Parameters<typeof branchDiff>) => {
      reads.push(`diff ${fixture.harness.calls.length}`);
      return branchDiff(...args);
    },
  };
  const { testImmutability } = fixture.options;
  fixture.options.testImmutability = (...args: Parameters<NonNullable<typeof testImmutability>>) => {
    reads.push(`changed tests ${fixture.harness.calls.length}`);
    return testImmutability!(...args);
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.equal(fixture.harness.calls.length, 4, 'red, green, the review and its nudge');
  assert.deepEqual(
    reads,
    ['changed tests 2', 'diff 2', 'changed tests 2'],
    "green's agent Attempt reads changed tests; the review Brief reads the diff and changed tests; " +
      'the nudge reads nothing',
  );
});

// A comment Action with `target: ticket` posts on the Ticket, under its own marker, not on the PR (W5).
test('a comment Action with target ticket posts on the Ticket', async (t) => {
  const fixture = await runReviewFlow(
    t,
    { [reviewKey(1)]: reviewed(review('ok')) },
    {
      configure: (configured) => {
        actionById(configured.procedures.review!, 'comment').target = 'ticket';
      },
    },
  );

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(prReviewComments(fixture), [], 'nothing on the PR');
  const commentMarker = golden.markerOf(fixture.executionRecord, 'reviewer', 1, 'comment');
  const posted = fixture.gh.comments.filter(
    (comment) => comment.number === golden.TICKET && comment.body.includes(marker.markerComment(commentMarker)),
  );
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /### gg review/);
  assert.deepEqual(
    (
      fixture.executionRecord.writeAheadLog.find(
        (entry) => entry.actionMarker === commentMarker && entry.step === 'intent',
      )!.payload as { target: unknown }
    ).target,
    {
      kind: 'issue',
      number: golden.TICKET,
    },
  );
});

test("the review comment names the reviewer's Persona with its hash", async (t) => {
  const fixture = await runReviewFlow(t, { [reviewKey(1)]: reviewed(review('ok')) });
  const hash = config.sha256(REVIEWER_PERSONA).slice(0, 12);
  assert.match(prReviewComments(fixture)[0].body, new RegExp(`, persona reviewer\\.md@${hash}_`));
});
