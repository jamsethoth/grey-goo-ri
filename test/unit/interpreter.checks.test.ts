import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import { signalsOf } from '../support/action-signals.ts';
import * as addSuite from '../support/add-suite.ts';
import { GREEN_FAIL_OUTPUT } from '../support/add-suite.ts';
import { actionEvent, headSha, intents, subjects } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import {
  RIGHT_ADD,
  WRONG_ADD,
  greenFixture,
  greenTrace,
  greenWrites,
  ranToEnd,
  tddTrace,
} from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import { actionById } from '../support/procedure-actions.ts';
import { MAJOR, fixed, review, reviewFixture, reviewed, runReviewFlow } from '../support/review-flow.ts';
import { answerAll, answerCommand, editRuns, type SuiteRun } from '../support/suite-runs.ts';

type GoldenFixture = golden.GoldenFixture;
type GoldenConfig = golden.GoldenConfig;
// A configured Procedure with the tables and Claim tokens a case edits.
type ConfiguredProcedure = GoldenConfig['procedures'][string] & {
  claimTokens: Record<string, unknown>;
  passed?: unknown[];
};
// A configured Vertex's routes or inputs, as a case edits them.
type Routes = Record<string, unknown>;
type Inputs = Record<string, Record<string, unknown>>;
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const RED_RECOVERY = keys.responseKey('red', 1, 'recover', 1);
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);

// The evidence an Action's saved output carries.
const evidenceOf = (fixture: GoldenFixture, vertex: string, action: string) =>
  fixture.executionRecord.outputs.find((output) => output.vertex === vertex && output.action === action)!.value
    .evidence as { output: string };

// Checks as declared Actions: their results are the Check signal { id, kind, state, tree }, and a final failure is the
// engine Outcome failed (#114).
test('a failed red at an end leaves its work in place', async (t) => {
  const responses = firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  const fixture = await golden.fixture(t, { responses });
  // The new test passes before any implementation exists, both times.
  answerAll(fixture, () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }));
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(
    readFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'utf8'),
    "import { add } from '../lib/add.mjs';\n",
    'the test red wrote is still there',
  );
  assert.equal(await headSha(fixture), fixture.base, 'nothing was committed');
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), [], 'nothing was reset');
  assert.deepEqual(fixture.executionRecord.history, []);
  assert.equal(fixture.executionRecord.terminalReason!.outcome, 'failed');
});

test('a final test failure is the Outcome failed naming the Check', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' }),
    },
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(fixture, 'green', 'test', 1)!;
  assert.equal(check.outcome, 'failed');
  assert.deepEqual(check.rule, { table: 'failed', row: null });
  assert.equal(check.check, 'test');
  const [signal] = signalsOf(check!).checks;
  // A failing Check's output reaches its signal and the Terminal comment, never its evidence (N9).
  assert.deepEqual(signal, {
    id: 'test',
    kind: 'command',
    state: 'failed',
    tree: signal!.tree,
    output: GREEN_FAIL_OUTPUT,
  });
  assert.match(signal!.tree!, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    fixture.executionRecord.outputs.filter((output) => output.vertex === 'green' && output.action === 'test')[0]!.value,
    { cleanup: addSuite.CONFIRMED },
    'no evidence, only what its command left',
  );
  const reason = fixture.executionRecord.terminalReason!;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 1 });
  assert.equal(reason.outcome, 'failed');
  assert.equal(reason.text, 'The command Check green.test failed with no recovery left.');
  assert.ok(
    fixture.gh.comments[0]!.body.includes(`\`\`\`\n${GREEN_FAIL_OUTPUT}\n\`\`\``),
    fixture.gh.comments[0]!.body,
  );
});

test('a Check result on an older tree does not count', async (t) => {
  const fixture = await golden.fixture(t);
  const appendEvent = fixture.options.events;
  // A file appears after green's test passed and before its commit, so the commit sees a tree the Check never saw.
  fixture.options.events = (type, data) => {
    appendEvent(type, data);
    const action = type === 'action' ? (data as events.EventInput<'action'>) : null;
    if (action?.vertex === 'green' && action.action === 'test')
      writeFileSync(join(fixture.worktree, 'lib', 'late.mjs'), 'export {};\n');
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const commit = actionEvent(fixture, 'green', 'commit')!;
  assert.equal(commit.outcome, 'failed');
  assert.equal(signalsOf(commit!).checks[0]!.id, 'test');
  assert.equal(signalsOf(commit!).checks[0]!.state, 'failed', 'a pass on an older tree counts as failed');
  assert.deepEqual(await subjects(fixture), ['test: Add two numbers (#15)'], 'no feat commit');
});

test('a Check that changes the tree fails', async (t) => {
  const fixture = await golden.fixture(t);
  // The passing run leaves a generated file behind.
  editRuns(fixture, (result) => {
    if (result.code === 0) writeFileSync(join(fixture.worktree, 'lib', 'generated.mjs'), 'export {};\n');
    return result;
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const check = actionEvent(fixture, 'green', 'test')!;
  assert.equal(check.outcome, 'failed');
  assert.equal(signalsOf(check!).checks[0]!.state, 'failed');
  assert.deepEqual(await subjects(fixture), ['test: Add two numbers (#15)'], 'no feat commit');
});

// implement with a second required command Check, lint, after test. The lint command answers with `lintRuns` in order.
const LINT_OUTPUT = 'lib/add.mjs: 1 problem (no-unused-vars)';
const LINT_FAILS = { code: 1, output: LINT_OUTPUT, timedOut: false };
const LINT_PASSES = { code: 0, output: '', timedOut: false };

// implement whose ok requires only a passing lint Check, so its failing test Check is recorded but blocks nothing;
// publish then reads green's evidence as optional, since a failing Check has none (N9).
function unrequiredTest(fixture: GoldenFixture) {
  golden.configure(fixture, (configured) => {
    configured.commands.lint = 'npm run lint';
    configured.procedures.implement!.actions.splice(2, 0, {
      id: 'lint',
      do: 'check',
      kind: 'command',
      command: 'lint',
    });
    (configured.procedures.implement as ConfiguredProcedure).claimTokens.ok = { requires: ['lint'] };
    (configured.flows.golden!.ticket.vertices.publish!.inputs as Inputs).green!.optional = true;
  });
  answerCommand(fixture, 'npm run lint', async () => LINT_PASSES);
}

function withLint(fixture: GoldenFixture, lintRuns: SuiteRun[]) {
  golden.configure(fixture, (configured) => {
    configured.commands.lint = 'npm run lint';
    configured.procedures.implement!.actions.splice(2, 0, {
      id: 'lint',
      do: 'check',
      kind: 'command',
      command: 'lint',
      recoverBrief: 'templates/test-fix.md',
    });
    (configured.procedures.implement as ConfiguredProcedure).claimTokens.ok = { requires: ['test', 'lint'] };
  });
  answerCommand(fixture, 'npm run lint', async () => lintRuns.shift()!);
}

// Claim tokens declare `requires` or `stop`, recovery is one per-Visit budget, and the Outcome is decided in one fixed
// order (#115; Q3, Q3d, T4, W1).
test("recovery resumes the Session with every failing Check's section", async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': RIGHT_ADD }),
    },
  });
  withLint(fixture, [LINT_FAILS, LINT_PASSES]);
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  const recovery = fixture.harness.calls[2]!;
  assert.equal(recovery.resume, 'fake-session-2', "the recovery pass resumes green's Session");
  assert.ok(recovery.brief!.includes(GREEN_FAIL_OUTPUT), `the test Check's section:\n${recovery.brief}`);
  assert.ok(recovery.brief!.includes(LINT_OUTPUT), `the lint Check's section:\n${recovery.brief}`);
  const check = actionEvent(fixture, 'green', 'lint')!;
  assert.deepEqual(
    [check.outcome, check.direction, check.rule],
    ['recover', 'retry', { table: 'fixed', row: 'recover' }],
  );
});

test('every Check runs again after recovery', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': RIGHT_ADD }),
    },
  });
  const lintRuns = [LINT_PASSES, LINT_PASSES];
  withLint(fixture, lintRuns);
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(greenTrace(fixture), [
    'green/0',
    'test/0',
    'lint/0',
    'green/1',
    'test/1',
    'lint/1',
    'commit/1',
    'push/1',
    'pr/1',
    'green ok -> publish',
  ]);
  assert.deepEqual(lintRuns, [], 'lint passed in the first pass and still ran again');
  assert.doesNotMatch(fixture.harness.calls[2]!.brief!, /Check lint/, 'a passing Check has no section');
});

test('a stop token after recovery stops', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: {
        files: {},
        response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'The test is wrong.' },
      },
    },
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    greenTrace(fixture),
    ['green/0', 'test/0', 'green/1', 'test/1', 'green blocked -> needs-human'],
    "the stop waits for its pass's Checks",
  );
  assert.match(fixture.gh.comments[0]!.body, /### gg: blocked/);
  const reason = fixture.executionRecord.terminalReason!;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'test', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['blocked', { table: 'stopped', row: null }]);
  assert.deepEqual(actionEvent(fixture, 'green', 'test', 1)!.rule, reason.rule);
});

test('pass is matchable in the passed table', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': RIGHT_ADD }),
    },
  });
  golden.configure(fixture, (configured) => {
    (configured.procedures.implement as ConfiguredProcedure).passed = [{ when: { pass: 2 }, outcome: 'recovered' }];
    (configured.flows.golden!.ticket.vertices.green!.route as Routes).recovered = { end: 'needs-human' };
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const reason = fixture.executionRecord.terminalReason!;
  assert.deepEqual(reason.decidedBy, { vertex: 'green', visit: 1, action: 'pr', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['recovered', { table: 'passed', row: 0 }]);
});

test('named tests missing from the output are recovered once, then fail', async (t) => {
  const responses = firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  const fixture = await golden.fixture(t, { responses });
  // The runner fails, but its output never names the reported test.
  answerAll(fixture, () => ({ code: 1, output: 'Error: something else broke', timedOut: false }));
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(tddTrace(fixture).map(golden.line((event) => `${event.action}/${event.recovery}`)), [
    'red/0',
    'red-check/0',
    'red/1',
    'red-check/1',
    'red failed -> needs-human',
  ]);
  const recovery = fixture.harness.calls[1]!;
  assert.equal(recovery.resume, 'fake-session-1', "the recovery pass resumes red's Session");
  assert.match(recovery.brief!, /as the runner prints them/);
  assert.ok(recovery.brief!.includes('Error: something else broke'), recovery.brief!);
  assert.deepEqual(actionEvent(fixture, 'red', 'red-check')!.rule, { table: 'fixed', row: 'recover' });
  const reason = fixture.executionRecord.terminalReason!;
  assert.deepEqual(reason.decidedBy, { vertex: 'red', visit: 1, action: 'red-check', recovery: 1 });
  assert.deepEqual([reason.outcome, reason.rule], ['failed', { table: 'failed', row: null }]);
});

test('a red that changed no test file is recovered once, then fails', async (t) => {
  const responses = firstVisitWith({ [RED_RECOVERY]: { files: {}, response: golden.redResponse } });
  responses[RED_CALL]!.files = { 'lib/note.mjs': 'export {};\n' };
  const fixture = await golden.fixture(t, { responses });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(fixture.shells, [], 'the test command never ran');
  assert.deepEqual(tddTrace(fixture).map(golden.line((event) => `${event.action}/${event.recovery}`)), [
    'red/0',
    'red-check/0',
    'red/1',
    'red-check/1',
    'red failed -> needs-human',
  ]);
  assert.match(fixture.harness.calls[1]!.brief!, /no-test-needed/, 'the section offers the no-test-needed stop');
  assert.deepEqual(
    [fixture.executionRecord.terminalReason!.outcome, fixture.executionRecord.terminalReason!.rule],
    ['failed', { table: 'failed', row: null }],
  );
});

test('a Check that passed and then failed in a recovery pass keeps no evidence of the earlier pass', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': RIGHT_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
    },
  });
  withLint(fixture, [LINT_FAILS, LINT_PASSES]);
  // ok requires only lint, so the Visit commits with test failing in its last pass.
  golden.configure(fixture, (configured) => {
    (configured.procedures.implement as ConfiguredProcedure).claimTokens.ok = { requires: ['lint'] };
    (configured.flows.golden!.ticket.vertices.publish!.inputs as Inputs).green!.optional = true;
  });
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(greenTrace(fixture).slice(0, 6), ['green/0', 'test/0', 'lint/0', 'green/1', 'test/1', 'lint/1']);
  assert.equal(signalsOf(actionEvent(fixture, 'green', 'test', 1)!).checks[0]!.state, 'failed');
  assert.equal(
    fixture.executionRecord.outputs.find((output) => output.vertex === 'green' && output.action === 'test')?.value
      .evidence,
    undefined,
    'the first pass evidence is gone (N9)',
  );
  assert.ok(
    fixture.gh.pr()!.body!.includes('**Green**: the test command has no passing run.\n'),
    fixture.gh.pr()!.body!,
  );
});

test('a command Check that times out is not recovered', async (t) => {
  const fixture = await greenFixture(t, { responses: { [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }) } });
  // red's Check fails as red should; green's test command then times out.
  const runs = [
    { code: 1, output: golden.RED_OUTPUT, timedOut: false },
    { code: null, output: 'killed after 30 min', timedOut: true },
  ];
  answerAll(fixture, () => runs.shift());
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(runs, [], 'the test command ran once in red and once in green');
  assert.deepEqual(greenTrace(fixture), ['green/0', 'test/0', 'green failed -> needs-human']);
  assert.deepEqual(fixture.executionRecord.terminalReason!.rule, { table: 'failed', row: null });
});

test('a failed Check produces no evidence output', async (t) => {
  const fixture = await greenFixture(t, { responses: { [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }) } });
  unrequiredTest(fixture);
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(
    fixture.executionRecord.outputs.filter((output) => output.vertex === 'green' && output.action === 'test')[0]!.value,
    { cleanup: addSuite.CONFIRMED },
    'a failing test no token requires has no evidence',
  );
  assert.ok(
    fixture.gh.pr()!.body!.includes('**Green**: the test command has no passing run.\n'),
    fixture.gh.pr()!.body!,
  );
  assert.equal(signalsOf(actionEvent(fixture, 'green', 'test')!).checks[0]!.state, 'failed');
  assert.equal(actionEvent(fixture, 'publish', 'test')!.outcome, 'failed', 'the Execution reached publish');
});

test('a tests-fail pass by name match alone carries foundByNameOnly: true in its evidence', async (t) => {
  const output = `Error: ${golden.TEST_NAME} threw\n`;
  const built = await reviewFixture(t, { [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('ok')) });
  // The runner prints no per-test statuses, only the test's name.
  editRuns(built, (result) => (result.code === 0 ? result : { ...result, output }));
  const fixture = await ranToEnd(built);

  assert.deepEqual(evidenceOf(fixture, 'red', 'red-check'), { command: 'npm test', output, foundByNameOnly: true });
  assert.match(
    fixture.harness.calls[2]!.brief!,
    /found the failing test by its name only/,
    'the review Brief shows it',
  );
});

// Declares reuse: tree on each named Procedure's test Check.
const reuseTree =
  (...names: string[]) =>
  (configured: GoldenConfig) => {
    for (const name of names) actionById(configured.procedures[name]!, 'test').reuse = 'tree';
  };

test(
  'a reuse: tree command Check reuses a pass for the same tree and command ' + 'and runs again for another',
  async (t) => {
    const fixture = await runReviewFlow(
      t,
      {
        [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('changes', [MAJOR])),
        [keys.responseKey('implementer-fix', 1, 'fix', 1)]: fixed({
          'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n',
        }),
        [keys.responseKey('reviewer', 2, 'review', 1)]: reviewed(review('ok')),
      },
      { configure: reuseTree('implement', 'fix', 'publish') },
    );

    assert.equal(fixture.result.outcome, 'ready-for-qa');
    assert.equal(
      fixture.shells.length,
      3,
      "red-check, green's test and the fix's test ran the command; publish reused the fix's pass",
    );
    assert.equal(evidenceOf(fixture, 'green', 'test').output, golden.GREEN_OUTPUT);
    assert.equal(
      evidenceOf(fixture, 'implementer-fix', 'test').output,
      golden.GREEN_OUTPUT,
      'the fix changed the tree, so its test ran again',
    );
    const fixTest = golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'test');
    assert.equal(
      evidenceOf(fixture, 'publish', 'test').output,
      `Reused the passing run of ${fixTest} on this tree.\n${golden.GREEN_OUTPUT}`,
    );
  },
);

test('a failing reuse: tree result is never reused', async (t) => {
  const fixture = await greenFixture(t, { responses: { [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }) } });
  golden.configure(fixture, reuseTree('implement', 'publish'));
  unrequiredTest(fixture);
  const runs: string[] = [];
  editRuns(fixture, (result, command) => {
    runs.push(command);
    return result;
  });
  await interpreter.runExecution(fixture.options);

  assert.deepEqual(
    runs,
    ['npm test', 'npm test', 'npm run lint', 'npm test'],
    'publish ran the test command again on the tree green failed on',
  );
  assert.equal(actionEvent(fixture, 'publish', 'test')!.outcome, 'failed');
});

test('a deleted test file counts as a change', async (t) => {
  const responses = firstVisitWith();
  responses[RED_CALL]!.files = {};
  const fixture = await golden.fixture(t, { responses });
  fixture.options.testPaths = ['package.json'];
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const result = await run(call);
    if (call.phase === 'red') rmSync(join(fixture.worktree, 'package.json'));
    return result;
  };
  await interpreter.runExecution(fixture.options);

  const check = actionEvent(fixture, 'red', 'red-check')!;
  assert.equal(check.outcome, 'ok');
  assert.equal(signalsOf(check!).checks[0]!.state, 'passed');
  assert.deepEqual(
    fixture.executionRecord.outputs.find((output) => output.vertex === 'red' && output.action === 'commit')!.value,
    { files: ['package.json'] },
  );
});

// A Check that ran no command started no process (owner, 2026-11-06).
test('the unchanged skip writes a confirmed cleanup', async (t) => {
  const quiet = { files: {}, response: golden.redResponse };
  const fixture = await golden.fixture(t, { responses: firstVisitWith({ [RED_CALL]: quiet, [RED_RECOVERY]: quiet }) });
  await interpreter.runExecution(fixture.options);
  assert.deepEqual(
    fixture.executionRecord.outputs.find((output) => output.vertex === 'red' && output.action === 'red-check')?.value
      .cleanup,
    { confirmed: true, survivors: [] },
  );
});

test('a reused pass writes a confirmed cleanup', async (t) => {
  const fixture = await runReviewFlow(
    t,
    {
      [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('ok')),
    },
    { configure: reuseTree('implement', 'publish') },
  );
  assert.deepEqual(
    fixture.executionRecord.outputs.find((output) => output.vertex === 'publish' && output.action === 'test')?.value
      .cleanup,
    { confirmed: true, survivors: [] },
  );
});

test('a pass with unconfirmed cleanup is not saved for reuse', async (t) => {
  const fixture = await golden.fixture(t);
  golden.configure(fixture, reuseTree('implement'));
  const unconfirmed = { ...addSuite.CONFIRMED, confirmed: false, reason: 'termination refused' };
  editRuns(fixture, (run) => (run.code === 0 ? { ...run, cleanup: unconfirmed } : run));
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'pending');
  const { tree } = fixture.executionRecord.visitState!.checks.get('test')!;
  assert.equal(stateDatabase.reusablePass(fixture.commonDir, tree!, 'npm test'), null);
});
