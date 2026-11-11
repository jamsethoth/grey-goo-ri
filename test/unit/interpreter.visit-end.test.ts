import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as reviewFlow from '../support/review-flow.ts';

// visit_end: each Visit's Outcome, its rule and the Edge it took, saved with the next cursor (#335).
const { MAJOR, finding, fixed, review, reviewed } = reviewFlow;
const reviewCall = (visitNumber: number) => keys.responseKey('reviewer', visitNumber, 'review', 1);
const fixCall = (vertex: string) => keys.responseKey(vertex, 1, 'fix', 1);
// A Vertex's routes, as a case edits them.
type Routes = Record<string, unknown>;

// Two changes reviews with the same Finding, so the second is a repeat, then an ok review.
const REPEATED_REVIEW = {
  [reviewCall(1)]: reviewed(review('changes', [MAJOR])),
  [fixCall('implementer-fix')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => a + b; // tried\n' }),
  [reviewCall(2)]: reviewed(review('changes', [MAJOR])),
  [fixCall('senior-dev')]: fixed({ 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' }),
  [reviewCall(3)]: reviewed(review('ok')),
};

const visitPlaces = (fixture: Pick<golden.GoldenFixture, 'readEvents'>) =>
  executionReads.visitEnds(fixture).map((visitEnd) => `${visitEnd.vertex}/${visitEnd.visit}`);

test('a review Visit whose passed table chose repeat writes visit_end with outcome repeat', async (t) => {
  const fixture = await reviewFlow.runReviewFlow(t, REPEATED_REVIEW);

  assert.deepEqual(
    executionReads.visitEnds(fixture).filter((visitEnd) => visitEnd.vertex === 'reviewer'),
    [
      {
        vertex: 'reviewer',
        visit: 1,
        outcome: 'changes',
        rule: { table: 'passed', row: 'otherwise' },
        next: 'implementer-fix',
        edge: 'reviewer->implementer-fix:changes',
        count: 1,
        spent: [],
      },
      {
        vertex: 'reviewer',
        visit: 2,
        outcome: 'repeat',
        rule: { table: 'passed', row: 1 },
        next: 'senior-dev',
        edge: 'reviewer->senior-dev:repeat',
        count: 1,
        spent: [],
      },
      {
        vertex: 'reviewer',
        visit: 3,
        outcome: 'ok',
        rule: { table: 'passed', row: 0 },
        next: 'publish',
        edge: null,
        count: null,
        spent: [],
      },
    ],
  );
});

test('a spent Edge Bound is listed in spent and routes to its exhausted target', async (t) => {
  const fixture = await reviewFlow.reviewFixture(
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
        const reviewer = configured.flows.golden!.ticket.vertices.reviewer!;
        (reviewer.route as Record<string, Routes>).changes = { to: 'implementer-fix', max: 1, exhausted: 'senior-dev' };
      },
    },
  );
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(
    executionReads.visitEnds(fixture).find((visitEnd) => visitEnd.vertex === 'reviewer' && visitEnd.visit === 2),
    {
      vertex: 'reviewer',
      visit: 2,
      outcome: 'changes',
      rule: { table: 'passed', row: 'otherwise' },
      next: 'senior-dev',
      edge: null,
      count: null,
      spent: [{ edge: 'reviewer->implementer-fix:changes' }],
    },
  );
});

test('a Visit routed to an end writes visit_end before ticket_end', async (t) => {
  const fixture = await goldenRun.runFirstVisit(t);

  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(
    fixture.events
      .filter((event) => event.type === 'visit_end' || event.type === 'ticket_end')
      .map((event) => (event.type === 'visit_end' ? `${event.vertex} -> ${event.next}` : event.type)),
    ['red -> green', 'green -> publish', 'publish -> ready-for-qa', 'ticket_end'],
  );
});

test('a restart after the cursor save writes no second visit_end', async (t) => {
  const fixture = await golden.fixture(t);
  // The save entering green fails after red's route into it was saved, which ends the process.
  const restore = caseDatabase.failSaves(
    t,
    (_saved, next) => (next as record.ExecutionRecord).configurationSnapshot?.vertex === 'green',
  );
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof record.RecordSaveError);
  restore();
  assert.deepEqual(visitPlaces(fixture), ['red/1']);

  const result = await interpreter.runExecution({ ...fixture.options, record: executionReads.loadTicket(fixture) });

  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(visitPlaces(fixture), ['red/1', 'green/1', 'publish/1']);
});

test('a restart before the cursor save writes the visit_end it lost', async (t) => {
  const fixture = await golden.fixture(t);
  // The save of red's route into green fails, and its visit_end, in the same transaction, is lost with it.
  const restore = caseDatabase.failSaves(t, (_saved, next) => {
    const { cursor } = next as record.ExecutionRecord;
    return cursor.vertex === 'green' && cursor.action === null;
  });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof record.RecordSaveError);
  restore();
  assert.deepEqual(visitPlaces(fixture), []);

  const result = await interpreter.runExecution({ ...fixture.options, record: executionReads.loadTicket(fixture) });

  assert.equal(result.outcome, 'ready-for-qa');
  assert.deepEqual(visitPlaces(fixture), ['red/1', 'green/1', 'publish/1']);
});

// Every Visit that ran an Action of its Procedure, in the order of its first Action Event.
const visitsRan = (fixture: Pick<golden.GoldenFixture, 'readEvents'>) => [
  ...new Set(
    fixture
      .readEvents()
      .flatMap((event) => (event.type === 'action' && event.procedure ? [`${event.vertex}/${event.visit}`] : [])),
  ),
];

// Both paths that end a Visit with an Outcome: completeVisit (every review Visit) and stopVisit (green's Action Cap).
test('every Visit whose Outcome takes its Edge writes exactly one visit_end', async (t) => {
  const completed = await reviewFlow.runReviewFlow(t, REPEATED_REVIEW);
  const stopped = await golden.fixture(t);
  golden.configure(stopped, (configured) => {
    configured.flows.golden!.actionCap = 4;
  });
  assert.equal((await interpreter.runExecution(stopped.options)).outcome, 'needs-human');

  assert.deepEqual(visitPlaces(completed), visitsRan(completed));
  assert.deepEqual(visitPlaces(stopped), visitsRan(stopped));
  assert.deepEqual(visitsRan(stopped), ['red/1', 'green/1'], 'the stopped flow ran two Visits');
});
