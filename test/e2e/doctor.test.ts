// The example Flow `gg init` writes (#120) where it rescues work: on real git with the real integrity, since a
// rescue's subject is git behaviour (docs/testing.md). test/unit/interpreter.test.ts runs the rest over the fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleRun from '../support/example-run.ts';
import * as golden from '../support/golden.ts';

const { call, requires, PASSED } = exampleRun;
const REAL = { git: 'real', integrity: 'real' } as const;

test('golden: a failed green escalates to senior-green and reaches ready-for-qa', async (t) => {
  const wrong = {
    files: { 'lib/add.mjs': 'export const add = (a, b) => a - b;\n' },
    response: exampleRun.greenResponse(),
  };
  const fixture = await exampleRun.runExample(t, {
    ...REAL,
    responses: {
      ...exampleRun.firstPass(),
      [call('green', 1, 'green')]: wrong,
      [call('green', 1, 'recover')]: wrong,
      [call('senior-green', 1, 'green')]: { files: exampleRun.ADD, response: exampleRun.greenResponse() },
    },
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
  assert.deepEqual(exampleRun.visited(fixture), ['baseline', 'red', 'green', 'senior-green', 'reviewer', ...PASSED]);
  const { ref } = exampleRun.outputOf(fixture.executionRecord, 'green', 'rescue') as { ref: string };
  assert.ok(
    exampleRun.briefOf(fixture, 'senior-green', 1).includes(`git diff HEAD ${ref}`),
    'senior-green reads the rescued work',
  );
});

test('golden: a bad-test stop returns to red, which rewrites the test, and green passes', async (t) => {
  const diagnosis = 'The test expects a - b; the ticket asks for a sum.';
  const fixture = await exampleRun.runExample(t, {
    ...REAL,
    responses: {
      ...exampleRun.firstPass(),
      [call('red', 1, 'red')]: {
        files: { 'test/adds.test.mjs': requires('lib/add.mjs', 'a - b') },
        response: exampleRun.redResponse(),
      },
      [call('green', 1, 'green')]: exampleRun.badTest(diagnosis),
      [call('red', 2, 'red')]: { files: exampleRun.ADDS_TEST, response: exampleRun.redResponse() },
      [call('green', 2, 'green')]: { files: exampleRun.ADD, response: exampleRun.greenResponse() },
    },
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
  assert.deepEqual(exampleRun.visited(fixture), ['baseline', 'red', 'green', 'red', 'green', 'reviewer', ...PASSED]);
  assert.ok(exampleRun.briefOf(fixture, 'red', 2).includes(diagnosis), "red's Brief shows green's diagnosis");
});

test(
  "golden: a green base broken by red's fixture change is not reported as a red base, " +
    "and green's bad-test returns it to red",
  async (t) => {
    const fixtureFile = 'test/fixtures/numbers.json';
    const fixture = await exampleRun.runExample(t, {
      ...REAL,
      baseFiles: { [fixtureFile]: '{"one": 1}\n', 'test/old.test.mjs': requires(fixtureFile, '"one": 1') },
      responses: {
        ...exampleRun.firstPass(),
        [call('red', 1, 'red')]: {
          files: { ...exampleRun.ADDS_TEST, [fixtureFile]: '{"one": "1"}\n' },
          response: exampleRun.redResponse(),
        },
        [call('green', 1, 'green')]: exampleRun.badTest("red's fixture change broke the old test."),
        [call('red', 2, 'red')]: { files: { [fixtureFile]: '{"one": 1}\n' }, response: exampleRun.redResponse() },
        [call('green', 2, 'green')]: { files: exampleRun.ADD, response: exampleRun.greenResponse() },
      },
    });
    assert.equal(fixture.result.outcome, 'ready-for-qa', JSON.stringify(fixture.executionRecord.terminalReason));
    assert.equal(golden.trace(fixture.events)[0]!.outcome, 'ok', 'the baseline passed');
    assert.deepEqual(exampleRun.visited(fixture), ['baseline', 'red', 'green', 'red', 'green', 'reviewer', ...PASSED]);
  },
);
