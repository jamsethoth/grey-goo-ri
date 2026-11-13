import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as attempt from '../../lib/attempt.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as config from '../../lib/config.ts';
import * as procedures from '../../lib/procedures.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as reviewFlow from '../support/review-flow.ts';
import type * as model from '../../lib/model.ts';
import type * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import type * as visitScope from '../../lib/visit-scope.ts';
import * as visitRunner from '../../lib/visit-runner.ts';
import * as support from '../support/execution-context.ts';

const IDENTITY = { vertex: 'red', visit: 1, procedure: 'tests-fail', action: 'red-check', recovery: 0 };

const tableResolution = (direction: visit.Direction): visit.TableResolution => ({
  outcome: 'ok',
  direction,
  rule: { table: 'passed', row: 0 },
  row: null,
  check: null,
  retryAfterMs: null,
  retryKind: null,
  failureClass: null,
});

// A Visit's saved state with the Procedure runVisit gives it: an agent Action, then two Checks.
function runningVisit(): visitScope.RunningVisit {
  const state: visit.VisitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  const proc: Pick<model.Procedure, 'actions'> = {
    actions: [
      { id: 'red', do: 'agent' },
      { id: 'lint', do: 'check' },
      { id: 'red-check', do: 'check' },
    ],
  };
  Object.defineProperty(state, 'proc', { value: proc, enumerable: false });
  Object.defineProperty(state, 'claimTokens', { value: new Map(), enumerable: false });
  return state as visitScope.RunningVisit;
}

test("a Flow Action's retry is not settled, so a resumed Visit runs the Action again", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const state = runningVisit();
  executionRecord.visitState = state;
  const settle = visitRunner.settleOf(executionRecord, { actionIdentity: IDENTITY, state });
  await attempt.run(context, {
    actionIdentity: IDENTITY,
    busy: false,
    work: async () => null,
    finish: () => ({ resolution: tableResolution('retry') }),
    settle,
  });
  assert.equal(state.settled, null);
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => [event.action, event.direction]),
    [['red-check', 'retry']],
    'its Action Event is still recorded',
  );
  settle(tableResolution('advance'));
  assert.deepEqual(state.settled, { action: 'red-check', recovery: 0, resolution: tableResolution('advance') });
});

test("a held completion's retry clears the held result, and one with none re-runs the Visit's Checks", async (t) => {
  const { executionRecord } = await support.executionContext(t);
  const state = runningVisit();
  const held = {
    action: 'red-check',
    recovery: 0,
    resolution: { ...tableResolution('stop'), row: 'cleanup-unconfirmed' },
  };
  state.settled = held as visit.VisitState['settled'];
  const settle = visitRunner.settleOf(executionRecord, { actionIdentity: IDENTITY, state }, { held: true });
  settle(tableResolution('retry'));
  assert.equal(state.settled, null, 'the next Attempt runs');

  state.settled = held as visit.VisitState['settled'];
  executionRecord.cursor = { vertex: 'red', visit: 1, action: 'red-check', recovery: 0, attempt: 1 };
  executionRecord.attempts = 4;
  settle(null);
  assert.equal(state.settled, null);
  assert.deepEqual(
    executionRecord.cursor,
    { vertex: 'red', visit: 1, action: 'lint', recovery: 0, attempt: 1 },
    'the cursor moves to the first Check, saved in the same write',
  );
  assert.equal(executionRecord.attempts, 5, 'the re-run counts once toward the Action Cap');
});

// Where a Procedure as declared names files, at each place procedures.FILE_KEYS declares but the Agent's: a place added
// there fails tsc here until this case reads it too.
const PROCEDURE_PLACES = {
  action: (procedure) => (procedure.actions as unknown[] | undefined) ?? [],
  recover: (procedure) => [procedure.recover],
  claimToken: (procedure) => Object.values((procedure.claimTokens as Record<string, unknown> | undefined) ?? {}),
} satisfies Record<Exclude<procedures.FilePlace, 'agent'>, (procedure: Record<string, unknown>) => unknown[]>;
const namedBy = (procedure: Record<string, unknown>) => [
  ...new Set(
    Object.entries(PROCEDURE_PLACES).flatMap(([place, declaredAt]) =>
      declaredAt(procedure).flatMap((declared) => procedures.filesAt(place as procedures.FilePlace, declared)),
    ),
  ),
];

// Another configuration's bytes for each file named: text gets a POISON line, and a schema its `required` reversed,
// so it still passes the strict subset but no longer equals the one the Visit entered with.
const POISON = 'POISON from a configuration the Visit did not enter with';
function poison(files: config.SourceFiles, names: string[]) {
  for (const name of names) {
    const { bytes } = files[name]!;
    if (!name.endsWith('.json')) {
      files[name] = golden.layerFile(`${POISON}\n${bytes}`);
      continue;
    }
    const schema = JSON.parse(bytes) as { required: string[] };
    files[name] = golden.layerFile(JSON.stringify({ ...schema, required: [...schema.required].reverse() }));
  }
}
const noPoison = (text: string, where: string) => assert.ok(!text.includes(POISON), `${where} read a later file`);
const prBodies = (executionRecord: record.ExecutionRecord) =>
  executionRecord.writeAheadLog
    .filter((entry) => entry.effect === 'pr-upsert' && entry.step === 'intent')
    .map((entry) => (entry.payload as { body: string }).body);

test('a Visit pins the bytes and hash of every file its Procedure names', async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: {
      [keys.responseKey('green', 1, 'green', 1)]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
      [keys.responseKey('green', 1, 'recover', 1)]: goldenRun.greenWrites({
        'lib/add.mjs': 'export const add = (a, b) => a + b;\n',
      }),
    },
  });
  const run = fixture.harness.run;
  let pinned: visit.ConfigurationSnapshot | null = null;
  fixture.harness.run = async (call) => {
    if (call.vertex === 'green') pinned ??= structuredClone(fixture.executionRecord.configurationSnapshot);
    return run(call);
  };
  await interpreter.runExecution(fixture.options);

  const names = namedBy(fixture.config.procedures.implement!);
  assert.ok(names.length >= 5, `the implement Procedure names its Brief, schema, recovery Briefs and templates`);
  assert.deepEqual(
    pinned!.files,
    Object.fromEntries(names.map((name) => [name, fixture.files[name]])),
    'each named file, by bytes and hash, and no other',
  );
});

// The DoD case of #381: a Brief edited between an Attempt and its recovery pass, the pass run by a later Run.
test('a recovery pass resumed by a later Run reads every file its Visit entered with', async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: {
      [keys.responseKey('green', 1, 'green', 1)]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
      [keys.responseKey('green', 1, 'recover', 1)]: goldenRun.greenWrites({
        'lib/add.mjs': 'export const add = (a, b) => a + b;\n',
      }),
    },
  });
  const { loaded } = await crashResume.crashed(fixture, ['green', 1, 'green', 0], 'after-completion');
  const entered = structuredClone(fixture.files);
  const names = namedBy(fixture.config.procedures.implement!);
  const later = structuredClone(fixture.files);
  poison(later, names);

  const result = await interpreter.runExecution({
    ...fixture.options,
    record: loaded as record.ExecutionRecord,
    files: later,
  });

  assert.equal(result.outcome, 'ready-for-qa');
  const [, green, recovery] = fixture.harness.calls;
  noPoison(recovery!.brief as string, 'the recovery Brief');
  const enteredText = entered['templates/recover.md']!.bytes.split('{{')[0]!;
  assert.ok((recovery!.brief as string).includes(enteredText), 'the recovery Brief is the one the Visit entered with');
  assert.deepEqual(recovery!.schema, green!.schema, 'the recovery call gets the schema the Visit entered with');
  const [greenBody, publishBody] = prBodies(executionReads.loadTicket(fixture));
  noPoison(greenBody!, "green's PR body");
  assert.ok(publishBody!.includes(POISON), 'the next Vertex entry takes the later configuration');
});

test("a stopped Visit's comment renders the template its Visit entered with", async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: {
      [keys.responseKey('green', 1, 'green', 1)]: {
        files: {},
        response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'The test is wrong.' },
      },
    },
  });
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const ran = await run(call);
    if (call.vertex === 'green') poison(fixture.files, namedBy(fixture.config.procedures.implement!));
    return ran;
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.gh.comments.length, 1);
  assert.match(fixture.gh.comments[0]!.body, /### gg: blocked/);
  noPoison(fixture.gh.comments[0]!.body, 'the stop comment');
});

test('a comment Action renders the body its Visit entered with', async (t) => {
  const fixture = await reviewFlow.reviewFixture(t, {
    [keys.responseKey('reviewer', 1, 'review', 1)]: reviewFlow.reviewed(reviewFlow.review('ok')),
  });
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const ran = await run(call);
    if (call.vertex === 'reviewer') poison(fixture.files, namedBy(fixture.config.procedures.review!));
    return ran;
  };
  const result = await interpreter.runExecution(fixture.options);

  assert.equal(result.outcome, 'ready-for-qa');
  const posted = reviewFlow.prReviewComments(fixture);
  assert.equal(posted.length, 1);
  noPoison(posted[0]!.body, 'the review comment');
});
