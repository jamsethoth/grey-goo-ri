import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as exampleRun from '../support/example-run.ts';
import * as golden from '../support/golden.ts';
import { editRuns } from '../support/suite-runs.ts';

// The example Flow `gg init` writes (#120), run end to end over the fakes; its rescues run on real git in
// test/e2e/doctor.test.ts.
const { call, requires, PASSED } = exampleRun;
const advanced = (vertex: string, action: string) => ({ vertex, action, recovery: 0, attempt: 1, outcome: 'ok' });
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test("golden: the example Flow's first-visit pass", async (t) => {
  const fixture = await exampleRun.runExample(t);
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(golden.trace(fixture.events), [
    advanced('baseline', 'test'),
    golden.visitEnded('baseline', 'red'),
    advanced('red', 'red'),
    advanced('red', 'red-check'),
    advanced('red', 'commit'),
    golden.visitEnded('red', 'green'),
    advanced('green', 'green'),
    advanced('green', 'test'),
    advanced('green', 'commit'),
    advanced('green', 'push'),
    advanced('green', 'pr'),
    golden.visitEnded('green', 'reviewer'),
    advanced('reviewer', 'review'),
    advanced('reviewer', 'review-pass'),
    advanced('reviewer', 'repeat'),
    advanced('reviewer', 'comment'),
    advanced('reviewer', 'pr'),
    golden.visitEnded('reviewer', 'publish', { rule: { table: 'passed', row: 0 } }),
    advanced('publish', 'test'),
    advanced('publish', 'pr'),
    advanced('publish', 'pr-ready'),
    golden.visitEnded('publish', 'ready-for-qa'),
    advanced('ready-for-qa', 'end-comment'),
    advanced('ready-for-qa', 'end-label'),
  ]);
});

test('golden: two retests and senior-red reach ready-for-qa within the Action Cap', async (t) => {
  const red = (visit: number, name: string, vertex = 'red') => ({
    [call(vertex, visit, 'red')]: {
      files: { [`test/${name}.test.mjs`]: requires('lib/add.mjs', name) },
      response: exampleRun.redResponse([name]),
    },
  });
  const green = (visit: number, ...names: string[]) => ({
    [call('green', visit, 'green')]: {
      files: { 'lib/add.mjs': `export const add = (a, b) => a + b; // ${names.join(' ')}\n` },
      response: exampleRun.greenResponse(),
    },
  });
  const fixture = await exampleRun.runExample(t, {
    responses: {
      ...exampleRun.firstPass(),
      [call('reviewer', 1, 'review')]: exampleRun.needsTest('no negative case'),
      ...red(2, 'negatives'),
      ...green(2, 'negatives'),
      [call('reviewer', 2, 'review')]: exampleRun.needsTest('no zero case'),
      ...red(3, 'zeros'),
      ...green(3, 'negatives', 'zeros'),
      [call('reviewer', 3, 'review')]: exampleRun.needsTest('no float case'),
      ...red(1, 'floats', 'senior-red'),
      ...green(4, 'negatives', 'zeros', 'floats'),
      [call('reviewer', 4, 'review')]: { files: {}, response: exampleRun.reviewResponse('ok') },
    },
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
  const loop = ['red', 'green', 'reviewer'];
  assert.deepEqual(exampleRun.visited(fixture), [
    'baseline',
    ...loop,
    ...loop,
    ...loop,
    'senior-red',
    'green',
    'reviewer',
    ...PASSED,
  ]);
  assert.ok(fixture.events.filter((event) => event.type === 'action').length <= fixture.flow.actionCap);
});

test('golden: a no-test red reaches review, and a needsTest review sends it back to red', async (t) => {
  const fixture = await exampleRun.runExample(t, {
    responses: {
      [call('red', 1, 'red')]: { files: {}, response: exampleRun.noTestResponse() },
      [call('green', 1, 'green')]: { files: exampleRun.ADD, response: exampleRun.greenResponse() },
      [call('reviewer', 1, 'review')]: exampleRun.needsTest('add has no test'),
      [call('red', 2, 'red')]: {
        files: { 'test/negatives.test.mjs': requires('lib/add.mjs', 'Number') },
        response: exampleRun.redResponse(['negatives']),
      },
      [call('green', 2, 'green')]: {
        files: { 'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b);\n' },
        response: exampleRun.greenResponse(),
      },
      [call('reviewer', 2, 'review')]: { files: {}, response: exampleRun.reviewResponse('ok') },
    },
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
  assert.deepEqual(exampleRun.visited(fixture), [
    'baseline',
    'red',
    'green',
    'reviewer',
    'red',
    'green',
    'reviewer',
    ...PASSED,
  ]);
  assert.match(
    exampleRun.briefOf(fixture, 'reviewer', 1),
    /A config default; no behaviour to test\./,
    'the reviewer judges it',
  );
});

test(
  'golden: a no-test red after a retest shows its notes to the reviewer ' +
    "although an earlier Visit's evidence exists",
  async (t) => {
    const fixture = await exampleRun.runExample(t, {
      responses: {
        ...exampleRun.firstPass(),
        [call('reviewer', 1, 'review')]: exampleRun.needsTest('no negative case'),
        [call('red', 2, 'red')]: { files: {}, response: exampleRun.noTestResponse('Negatives add like positives.') },
        [call('green', 2, 'green')]: { files: {}, response: exampleRun.greenResponse() },
        [call('reviewer', 2, 'review')]: { files: {}, response: exampleRun.reviewResponse('ok') },
      },
    });
    assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
    assert.deepEqual(exampleRun.visited(fixture), [
      'baseline',
      'red',
      'green',
      'reviewer',
      'red',
      'green',
      'reviewer',
      ...PASSED,
    ]);
    const second = exampleRun.briefOf(fixture, 'reviewer', 2);
    assert.match(second, /Negatives add like positives\./);
    assert.match(second, /✖ adds/, "the first red Visit's evidence is still the reviewer's red input");
  },
);

test('golden: a publish whose suite fails ends at needs-human naming publish.test', async (t) => {
  const fixture = await exampleRun.exampleFixture(t);
  let runs = 0;
  editRuns(fixture, (result) => (++runs === 4 ? { ...result, code: 1, output: '✖ adds (1ms)\nℹ fail 1' } : result));
  await interpreter.runExecution(fixture.options);
  assert.equal(
    fixture.executionRecord.terminalReason?.text,
    'The command Check publish.test failed with no recovery left.',
  );
  assert.deepEqual(exampleRun.visited(fixture), ['baseline', 'red', 'green', 'reviewer', 'publish', 'needs-human']);
});

// A test on main that fails, as a broken base has.
const BROKEN_BASE = { 'test/old.test.mjs': requires('lib/missing.mjs', 'anything') };

test('golden: a red base ends at needs-human before any agent runs', async (t) => {
  const fixture = await exampleRun.runExample(t, { baseFiles: BROKEN_BASE });
  assert.equal(fixture.result.outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 0, 'no agent ran');
  assert.equal(
    fixture.executionRecord.terminalReason?.text,
    'The command Check baseline.test failed with no recovery left.',
  );
  assert.match(fixture.gh.comments.at(-1)?.body ?? '', /✖ old/, 'the comment shows the failing output');
});

test('golden: a second Ticket on the same green base reuses the baseline pass', async (t) => {
  const fixture = await exampleRun.runExample(t);
  let runs = 0;
  const next = await exampleRun.nextTicket(fixture, () => runs++);
  const { outcome } = await interpreter.runExecution(next.options);
  assert.equal(outcome, 'ready-for-qa');
  const baseline = golden.markerOf(fixture.executionRecord, 'baseline', 1, 'test');
  assert.match(
    (exampleRun.outputOf(next.record, 'baseline', 'test') as { evidence: { output: string } }).evidence.output,
    new RegExp(`^Reused the passing run of ${escaped(baseline)} on this tree\\.`),
  );
  assert.equal(runs, 3, "red-check, green's test and publish's test ran; the baseline did not");
});

test('golden: a failed baseline runs again for the next Ticket', async (t) => {
  const fixture = await exampleRun.runExample(t, { baseFiles: BROKEN_BASE });
  let runs = 0;
  const next = await exampleRun.nextTicket(fixture, () => runs++);
  const { outcome } = await interpreter.runExecution(next.options);
  assert.equal(outcome, 'needs-human');
  assert.equal(runs, 1, 'the baseline ran again');
  assert.equal(next.record.terminalReason?.text, 'The command Check baseline.test failed with no recovery left.');
});
