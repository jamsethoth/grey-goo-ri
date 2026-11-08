import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import { addSuite } from '../support/add-suite.ts';
import * as caseDatabase from '../support/case-database.ts';
import { actionEvent, loadTicket } from '../support/execution-reads.ts';
import { fakeHarness } from '../support/fake-harness.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import { WRONG_ADD, greenFixture, greenWrites, stopReason } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { MAJOR, finding, fixed, review, reviewFixture, reviewed, runReviewFlow } from '../support/review-flow.ts';

type GoldenFixture = golden.GoldenFixture;
type GoldenConfig = golden.GoldenConfig;
// A configured Vertex's routes, as a case edits them.
type Routes = Record<string, Record<string, unknown>>;
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);
const reviewCall = (visitNumber: number) => keys.responseKey('reviewer', visitNumber, 'review', 1);
const fixCall = (vertex: string, visitNumber = 1) => keys.responseKey(vertex, visitNumber, 'fix', 1);
const verticesOf = (configured: GoldenConfig) => configured.flows.golden!.ticket.vertices;

// A Vertex max, the Action Cap and repeat routing (#117; request 3.3; T5, R4d, U5, V1).
const reviewTrace = (fixture: { actions: events.ActionEvent[] }) =>
  fixture.actions.map((event) => `${event.vertex}/${event.visit}/${event.action}`);
// The Actions of red, green, three reviews with implementer-fix's and then senior-dev's fix between them, and publish.
const THREE_REVIEWS = [
  'red/1/red',
  'red/1/red-check',
  'red/1/commit',
  'green/1/green',
  'green/1/test',
  'green/1/commit',
  'green/1/push',
  'green/1/pr',
  'reviewer/1/review',
  'reviewer/1/review-pass',
  'reviewer/1/repeat',
  'reviewer/1/comment',
  'reviewer/1/pr',
  'implementer-fix/1/fix',
  'implementer-fix/1/test',
  'implementer-fix/1/commit',
  'implementer-fix/1/push',
  'implementer-fix/1/pr',
  'reviewer/2/review',
  'reviewer/2/review-pass',
  'reviewer/2/repeat',
  'reviewer/2/comment',
  'reviewer/2/pr',
  'senior-dev/1/fix',
  'senior-dev/1/test',
  'senior-dev/1/commit',
  'senior-dev/1/push',
  'senior-dev/1/pr',
  'reviewer/3/review',
  'reviewer/3/review-pass',
  'reviewer/3/repeat',
  'reviewer/3/comment',
  'reviewer/3/pr',
  'publish/1/test',
  'publish/1/pr',
  'publish/1/pr-ready',
];

test('golden: a repeated review escalates', async (t) => {
  const fixture = await runReviewFlow(t, {
    [reviewCall(1)]: reviewed(review('changes', [MAJOR])),
    [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // tried\n' }),
    [reviewCall(2)]: reviewed(review('changes', [MAJOR])),
    [fixCall('senior-dev')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [reviewCall(3)]: reviewed(review('ok')),
  });

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(reviewTrace(fixture), THREE_REVIEWS);
  assert.deepEqual(fixture.actionsAt('reviewer', 2, 'repeat')[0]!.signals.checks, [
    { id: 'repeat', kind: 'repeat', state: 'failed', tree: null },
  ]);
  assert.deepEqual(
    Object.fromEntries(fixture.executionRecord.traversals),
    { 'reviewer->implementer-fix:changes': 1, 'reviewer->senior-dev:repeat': 1 },
    'the repeat takes its own Edge, not changes',
  );
  assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
    red: 1,
    green: 1,
    reviewer: 3,
    'implementer-fix': 1,
    'senior-dev': 1,
    publish: 1,
  });
});

// changes -> implementer-fix (max 2), and implementer-fix has max 1 with its own exhausted target.
const fixBoundSetup = (t: TestContext, changes: Record<string, unknown>) =>
  reviewFixture(
    t,
    {
      [reviewCall(1)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
      [reviewCall(2)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'second problem')])),
      [fixCall('senior-dev')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewCall(3)]: reviewed(review('ok')),
    },
    {
      configure: (configured) => {
        const vertices = verticesOf(configured);
        Object.assign(vertices['implementer-fix']!, { max: 1, exhausted: 'senior-dev' });
        Object.assign((vertices.reviewer!.route as Routes).changes!, changes);
      },
    },
  );
const runReview = async (fixture: GoldenFixture) => {
  const result = await interpreter.runExecution(fixture.options);
  const ran = fixture.readEvents();
  const actions = ran.filter((event): event is events.ActionEvent => event.type === 'action' && !!event.procedure);
  return { ...fixture, result, events: ran, actions };
};

test("golden: a spent Vertex max takes the Vertex's exhausted target", async (t) => {
  const fixture = await runReview(await fixBoundSetup(t, {}));

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(reviewTrace(fixture), THREE_REVIEWS);
  assert.deepEqual(
    Object.fromEntries(fixture.executionRecord.traversals),
    { 'reviewer->implementer-fix:changes': 1 },
    'an Edge whose Vertex is spent is not traversed',
  );
  assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
    red: 1,
    green: 1,
    reviewer: 3,
    'implementer-fix': 1,
    'senior-dev': 1,
    publish: 1,
  });
});

test("when an Edge and its Vertex exhaust together the Vertex's exhausted target wins", async (t) => {
  const fixture = await runReview(await fixBoundSetup(t, { max: 1, exhausted: { end: 'needs-human' } }));

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
    red: 1,
    green: 1,
    reviewer: 3,
    'implementer-fix': 1,
    'senior-dev': 1,
    publish: 1,
  });
});

test('a spent Bound that ends the Execution names the effective target in the Terminal Reason', async (t) => {
  const built = await fixBoundSetup(t, {});
  golden.configure(built, (configured) => {
    verticesOf(configured)['implementer-fix']!.exhausted = { end: 'needs-human' };
  });
  const fixture = await runReview(built);

  assert.equal(fixture.result.outcome, 'needs-human');
  assert.equal(
    fixture.executionRecord.terminalReason!.text,
    'reviewer visit 2 completed every review Action with outcome changes, and ' +
      'implementer-fix had used its Bound of 1 Visit, so the route ended at needs-human.',
  );
  assert.deepEqual(
    fixture.actions.filter((event) => 'exhausted' in event),
    [],
    'no Action Event carries exhausted',
  );
});

test('a restart at a bound routes the same way', async (t) => {
  const fixture = await fixBoundSetup(t, {});
  // The save of the route into senior-dev fails, which ends the process, so the restart routes reviewer/2's saved
  // result again.
  const restore = caseDatabase.failSaves(
    t,
    (_saved, next) =>
      (next as record.ExecutionRecord).cursor.vertex === 'senior-dev' &&
      (next as record.ExecutionRecord).cursor.action === null,
  );
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof record.RecordSaveError);
  restore();
  const saved = await loadTicket(fixture);
  assert.deepEqual(saved.cursor, { vertex: 'reviewer', visit: 2, action: 'pr', recovery: 0, attempt: 1 });

  const calls = fixture.harness.calls.length;
  const result = await interpreter.runExecution({ ...fixture.options, record: saved });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(
    fixture.harness.calls.slice(calls).map((call) => call.marker),
    [golden.markerOf(saved, 'senior-dev', 1, 'fix'), golden.markerOf(saved, 'reviewer', 3, 'review')],
  );
  assert.deepEqual(Object.fromEntries(saved.visits), {
    red: 1,
    green: 1,
    reviewer: 3,
    'implementer-fix': 1,
    'senior-dev': 1,
    publish: 1,
  });
});

// red's three Actions and green's agent call are the four Attempts of a cap of 4, so green's test Check is refused.
const cappedSetup = async (t: TestContext, cap = 4) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.actionCap = cap;
  });
  return fixture;
};

test('the Action Cap ends the Ticket at needs-human', async (t) => {
  const fixture = await cappedSetup(t);
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.deepEqual(
    golden
      .trace(fixture.readEvents())
      .filter((event) => event.vertex === 'red' || event.vertex === 'green')
      .map((event) => `${event.vertex}/${event.action}`),
    ['red/red', 'red/red-check', 'red/commit', 'green/green'],
    'no Attempt past the cap runs',
  );
  assert.equal(fixture.shells.length, 1, "only red's Check ran the tests");
  const reason = stopReason(fixture, {
    vertex: 'green',
    action: 'test',
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'action-cap' },
  });
  assert.equal(reason.text, 'The Execution reached its Action Cap of 4 Attempts, so test at green did not run.');
});

test("the Red Check compares untracked tests with the Visit's first baseline", async (t) => {
  const responses = firstVisitWith({
    [keys.responseKey('red', 1, 'recover', 1)]: { files: {}, response: golden.redResponse },
  });
  responses[RED_CALL]!.files = {};
  const fixture = await golden.fixture(t, { responses });
  // Build output under a test glob, ignored and left from before the Visit; red writes no test, in either pass.
  writeFileSync(join(fixture.worktree, '.gitignore'), 'test/cache/\n');
  mkdirSync(join(fixture.worktree, 'test', 'cache'), { recursive: true });
  writeFileSync(join(fixture.worktree, 'test', 'cache', 'out.json'), '{}\n');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(fixture, 'red', 'red-check')!.outcome, 'recover', 'no test changed is recoverable (K7)');
  assert.deepEqual(fixture.shells, [], 'the file was there at the baseline, so the test command never ran');
});

// JSON drops a key whose value is undefined, so a saved record must hold none.
const undefinedPaths = (value: unknown, path = 'record'): string[] => {
  if (value === undefined) return [path];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
};

test('a stop a Visit decides saves a Terminal stop and Check runs that declare every field', async (t) => {
  const saved: Omit<record.ExecutionRecord, 'commonDir'>[] = [];
  caseDatabase.onSave(t, (next) => {
    const { commonDir: _commonDir, ...persisted } = next as record.ExecutionRecord;
    saved.push(structuredClone(persisted));
  });
  const fixture = await cappedSetup(t);
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.outcome, 'needs-human');

  const { terminalStop } = await loadTicket(fixture);
  assert.deepEqual(Object.keys(terminalStop!), [
    'outcome',
    'response',
    'actionRef',
    'held',
    'abandoned',
    'inProgress',
    'fresh',
    'stopped',
    'commentTemplate',
    'advice',
    'detail',
    'error',
    'failureClass',
    'interrupted',
  ]);
  assert.deepEqual(terminalStop!.actionRef, {
    vertex: 'green',
    visit: 1,
    procedure: 'implement',
    action: 'test',
    recovery: 0,
  });
  assert.equal(terminalStop!.commentTemplate, null);
  const redCheck = saved.findLast((next) => next.visitState?.runs.get('red-check'))?.visitState!.runs.get('red-check');
  assert.deepEqual(Object.keys(redCheck ?? {}), ['output', 'reason', 'failure', 'recoverable']);
  assert.equal(redCheck!.reason, null, 'a command Check gives no reason');
  assert.deepEqual(
    saved.flatMap((next) => undefinedPaths(next)),
    [],
    'no save holds an undefined value',
  );
});

test('an Attempt retry counts toward the Action Cap', async (t) => {
  const fixture = await golden.fixture(t, { responses: firstVisitWith({ [RED_CALL]: { response: null } }) });
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.actionCap = 1;
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 1, 'the parse retry is the second Attempt, past the cap');
  stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'action-cap' },
  });
});

test('the needs-human report runs after the cap is reached', async (t) => {
  const fixture = await cappedSetup(t);
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(
    golden
      .trace(fixture.readEvents())
      .filter((event) => event.vertex === 'needs-human')
      .map((event) => `${event.action}/${event.outcome}`),
    ['end-comment/ok', 'end-label/ok'],
    'the report is traced',
  );
  assert.equal(fixture.gh.comments.filter((comment) => comment.number === golden.TICKET).length, 1);
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human']);
  assert.equal(fixture.executionRecord.state, 'needs-human');
});

test('a crash during that report resumes only the report', async (t) => {
  const fixture = await cappedSetup(t);
  const comment = golden.markerOf(fixture.executionRecord, 'needs-human', 1, 'end-comment');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: comment, point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const before = fixture.readEvents().length;
  const calls = fixture.harness.calls.length;
  const shells = fixture.shells.length;

  const result = await interpreter.runExecution({ ...fixture.options, record: await loadTicket(fixture) });
  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, calls, 'no agent runs again');
  assert.equal(fixture.shells.length, shells, 'no Check runs');
  assert.deepEqual(
    fixture
      .readEvents()
      .slice(before)
      .filter((event) => event.type === 'action')
      .map((event) => `${event.vertex}/${event.action}`),
    ['needs-human/end-comment', 'needs-human/end-label'],
    'only the report resumes',
  );
  assert.equal(
    fixture.gh.comments.filter((posted) => posted.number === golden.TICKET).length,
    1,
    'the comment is not posted twice',
  );
  assert.equal((await loadTicket(fixture)).state, 'needs-human');
});

test('a route passes through a chain of spent Vertices to the last exhausted target', async (t) => {
  // review 2 repeats review 1 and escalates to senior-dev; review 3's changes then finds implementer-fix and senior-dev
  // both spent, so the route passes from one exhausted target to the next.
  const fixture = await reviewFixture(
    t,
    {
      [reviewCall(1)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
      [reviewCall(2)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
      [fixCall('senior-dev')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // two\n' }),
      [reviewCall(3)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'third problem')])),
    },
    {
      configure: (configured) => {
        const vertices = verticesOf(configured);
        Object.assign(vertices['implementer-fix']!, { max: 1, exhausted: 'senior-dev' });
        vertices['senior-dev']!.exhausted = { end: 'needs-replan' };
      },
    },
  ).then(runReview);

  assert.equal(fixture.result.outcome, 'needs-replan');
  assert.equal(
    fixture.executionRecord.terminalReason!.text,
    'reviewer visit 3 completed every review Action with outcome changes, and ' +
      'implementer-fix had used its Bound of 1 Visit and senior-dev had used its Bound of 1 Visit, ' +
      'so the route ended at needs-replan.',
  );
});

test('an ok route into a spent Vertex names the Bound in the Terminal Reason', async (t) => {
  const fixture = await reviewFixture(
    t,
    {
      [reviewCall(1)]: reviewed(review('changes', [MAJOR])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    },
    {
      configure: (configured) => {
        Object.assign(verticesOf(configured).reviewer!, { max: 1, exhausted: { end: 'needs-human' } });
      },
    },
  ).then(runReview);

  assert.equal(fixture.result.outcome, 'needs-human');
  assert.equal(
    fixture.executionRecord.terminalReason!.text,
    'implementer-fix visit 1 completed every fix Action: test passed, and reviewer had used ' +
      'its Bound of 1 Visit, so the route ended at needs-human.',
  );
});

test('a restart does not count the resumed Attempt again toward the Action Cap', async (t) => {
  // red's three Actions are the cap of 3; the process dies inside the third, red's commit, after its effect.
  const fixture = await cappedSetup(t, 3);
  const commit = golden.markerOf(fixture.executionRecord, 'red', 1, 'commit');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: commit, point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );

  fixture.executionRecord = await loadTicket(fixture);
  const result = await interpreter.runExecution({ ...fixture.options, record: fixture.executionRecord });
  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 1, 'only red called the agent');
  stopReason(fixture, {
    vertex: 'green',
    action: 'green',
    outcome: 'needs-human',
    rule: { table: 'fixed', row: 'action-cap' },
  });
});

// Request 3.3's worked example: nested retries, a cap boundary and a restart in one Execution. red's call is retried
// for parse (Attempt 2) and green's test fails once, so green's call runs a recovery pass: both count toward the Action
// Cap, neither toward a Visit or an Edge. reviewer/2's changes find their Edge spent (max 1), whose exhausted target is
// senior-dev; the cap of 26 is used by then, so senior-dev's first Attempt is refused and the cap wins over the Bound.
// The process dies as it saves that route, and the restart routes the same way.
async function workedExampleCrash(t: TestContext) {
  const fixture = await reviewFixture(
    t,
    {
      [RED_CALL]: { response: null },
      [keys.responseKey('red', 1, 'red', 2)]: structuredClone(golden.firstVisitResponses[RED_CALL]!),
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
      [reviewCall(1)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // fixed\n' }),
      [reviewCall(2)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'second problem')])),
    },
    {
      configure: (configured) => {
        configured.flows.golden!.actionCap = 26;
        (verticesOf(configured).reviewer!.route as Routes).changes = {
          to: 'implementer-fix',
          max: 1,
          exhausted: 'senior-dev',
        };
      },
    },
  );
  // The suite passes only once lib/add.mjs really adds, so green's first test Check fails.
  fixture.options.deps.exec = addSuite({ worktree: fixture.worktree, checksSum: true });
  const restore = caseDatabase.failSaves(
    t,
    (_saved, next) =>
      (next as record.ExecutionRecord).cursor.vertex === 'senior-dev' &&
      (next as record.ExecutionRecord).cursor.action === null,
  );
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof record.RecordSaveError);
  restore();
  return fixture;
}
// The 26 Attempts the worked example's cap allows, as `vertex/action/recovery/attempt`.
const CAPPED_TRACE = [
  'red/red/0/1',
  'red/red/0/2',
  'red/red-check/0/1',
  'red/commit/0/1',
  'green/green/0/1',
  'green/test/0/1',
  'green/green/1/1',
  'green/test/1/1',
  'green/commit/1/1',
  'green/push/1/1',
  'green/pr/1/1',
  'reviewer/review/0/1',
  'reviewer/review-pass/0/1',
  'reviewer/repeat/0/1',
  'reviewer/comment/0/1',
  'reviewer/pr/0/1',
  'implementer-fix/fix/0/1',
  'implementer-fix/test/0/1',
  'implementer-fix/commit/0/1',
  'implementer-fix/push/0/1',
  'implementer-fix/pr/0/1',
  'reviewer/review/0/1',
  'reviewer/review-pass/0/1',
  'reviewer/repeat/0/1',
  'reviewer/comment/0/1',
  'reviewer/pr/0/1',
];

test(
  'worked example: retries and a recovery pass count toward the cap, ' +
    'which wins over a spent Bound across a restart',
  async (t) => {
    const fixture = await workedExampleCrash(t);
    fixture.executionRecord = await loadTicket(fixture);
    assert.deepEqual(
      fixture.executionRecord.cursor,
      { vertex: 'reviewer', visit: 2, action: 'pr', recovery: 0, attempt: 1 },
      'the route was not saved',
    );

    const calls = fixture.harness.calls.length;
    const result = await interpreter.runExecution({ ...fixture.options, record: fixture.executionRecord });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(fixture.harness.calls.length, calls, 'no agent runs after the restart');
    assert.deepEqual(
      golden
        .trace(fixture.readEvents())
        .filter((event) => !['needs-human'].includes(event.vertex))
        .map((event) => `${event.vertex}/${event.action}/${event.recovery}/${event.attempt}`),
      CAPPED_TRACE,
      'the 26 Attempts the cap allows',
    );
    assert.deepEqual(
      Object.fromEntries(fixture.executionRecord.visits),
      { red: 1, green: 1, reviewer: 2, 'implementer-fix': 1, 'senior-dev': 1 },
      'retries and recovery add no Visit',
    );
    assert.deepEqual(Object.fromEntries(fixture.executionRecord.traversals), {
      'reviewer->implementer-fix:changes': 1,
    });
    // The review's comments are write-ahead too, so the Terminal Reason's comment is found on the Ticket.
    const reason = stopReason(fixture, {
      vertex: 'senior-dev',
      action: 'fix',
      outcome: 'needs-human',
      rule: { table: 'fixed', row: 'action-cap' },
      comment: false,
    });
    assert.equal(reason.text, 'The Execution reached its Action Cap of 26 Attempts, so fix at senior-dev did not run.');
    assert.equal(
      fixture.gh.comments.filter(
        (posted) => posted.number === golden.TICKET && posted.body.includes(`**Terminal Reason:** ${reason.text}`),
      ).length,
      1,
    );
  },
);

// The repeat Check compares a review only with earlier Visits of the same Vertex in the same Execution (request 3.3,
// R4c). Each matching list sits at another Visit number than the review asserted, so the scope, not the Visit, keeps
// it out.
test("a repeat Check ignores another Vertex's identical findings", async (t) => {
  const minor = [finding('minor', 'lib/add.mjs', 'name the parameters')];
  // reviewer/2 and reviewer-2/1 give the same findings.
  const fixture = await reviewFixture(
    t,
    {
      [reviewCall(1)]: reviewed(review('changes', [MAJOR])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewCall(2)]: reviewed(review('ok', minor)),
      [keys.responseKey('reviewer-2', 1, 'review', 1)]: reviewed(review('ok', minor)),
    },
    {
      configure: (configured) => {
        const vertices = verticesOf(configured);
        vertices['reviewer-2'] = {
          ...structuredClone(vertices.reviewer!),
          route: { ...(vertices.reviewer!.route as Routes), ok: 'publish' },
        };
        (vertices.reviewer!.route as Record<string, unknown>).ok = 'reviewer-2';
      },
    },
  );
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa');
  const repeat = fixture
    .readEvents()
    .find((event) => event.type === 'action' && event.vertex === 'reviewer-2' && event.action === 'repeat');
  assert.deepEqual(
    (repeat as events.ActionEvent).signals.checks,
    [{ id: 'repeat', kind: 'repeat', state: 'passed', tree: null }],
    "reviewer's second review is not reviewer-2's first",
  );
});

// Ticket 16's Execution in the same repository and State Database as `fixture`'s Ticket 15, on its own worktree and
// branch: its record, saved, and a Harness whose first review reports MAJOR.
async function secondTicket(fixture: GoldenFixture) {
  const branch = 'ticket/16-add-again';
  const worktree = join(fixture.root, 'wt', 'ticket-16');
  await fixture.options.deps.git.ensureWorktree({ mainRoot: fixture.mainRoot, path: worktree, branch, base: 'main' });
  const next = record.createExecutionRecord({
    commonDir: fixture.commonDir,
    ticket: 16,
    epic: 1,
    flow: { name: fixture.flow.name, entry: fixture.flow.ticket.entry as string },
    configHash: 'cfg-hash',
    run: fixture.executionRecord.run,
    worktree,
    branch,
    base: 'main',
  });
  await record.save(next);
  const harness = fakeHarness({
    transcriptDir: join(fixture.root, 'transcripts-16'),
    capabilities: { costReporting: false, reasoningTokenReporting: false },
    responses: firstVisitWith({
      [reviewCall(1)]: reviewed(review('changes', [MAJOR])),
      [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
      [reviewCall(2)]: reviewed(review('ok')),
    }),
  });
  return { branch, next, harness };
}

test("a repeat Check ignores an earlier Execution's identical findings", async (t) => {
  // Ticket 15's second review reports MAJOR, and its Execution ends at ready-for-qa. Ticket 16 then runs in the same
  // repository and State Database, on its own worktree and Harness script: its first review reports MAJOR too.
  const fixture = await runReviewFlow(t, {
    [reviewCall(1)]: reviewed(review('changes', [finding('major', 'lib/add.mjs', 'first problem')])),
    [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' }),
    [reviewCall(2)]: reviewed(review('changes', [MAJOR])),
    [fixCall('implementer-fix', 2)]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
    [reviewCall(3)]: reviewed(review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');

  const { branch, next, harness } = await secondTicket(fixture);
  const result = await interpreter.runExecution({
    ...fixture.options,
    record: next,
    harness: harness as unknown as runContext.Harness,
    ticket: { number: 16, title: 'Add two numbers again', body: 'Add `add(a, b)` again.', branch },
  });

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const repeat = fixture
    .readEvents()
    .find(
      (event) =>
        event.type === 'action' &&
        event.execution === next.execution &&
        event.vertex === 'reviewer' &&
        event.visit === 1 &&
        event.action === 'repeat',
    );
  assert.deepEqual(
    (repeat as events.ActionEvent).signals.checks,
    [{ id: 'repeat', kind: 'repeat', state: 'passed', tree: null }],
    "ticket 15's second review is not ticket 16's first",
  );
  assert.deepEqual(
    Object.fromEntries(next.traversals),
    { 'reviewer->implementer-fix:changes': 1 },
    'the review routes as changes, not repeat',
  );
});

test("a repeat Check rerun in a recovery pass does not match its own Visit's first pass", async (t) => {
  // green's first pass fails its test Check, so a recovery pass reruns every Check of the Visit, the repeat Check
  // included, while the first pass's hash of the same list is already saved for this Visit.
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }),
    },
  });
  golden.configure(fixture, (configured) => {
    configured.procedures.implement!.actions.splice(2, 0, {
      id: 'again',
      do: 'check',
      kind: 'repeat',
      list: 'response.definitionOfDone',
      fields: ['item'],
    });
  });
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(actionEvent(fixture, 'green', 'again', 0)!.signals.checks, [
    { id: 'again', kind: 'repeat', state: 'passed', tree: null },
  ]);
  assert.deepEqual(
    actionEvent(fixture, 'green', 'again', 1)!.signals.checks,
    [{ id: 'again', kind: 'repeat', state: 'passed', tree: null }],
    'the recovery pass repeats nothing an earlier Visit recorded',
  );
});
