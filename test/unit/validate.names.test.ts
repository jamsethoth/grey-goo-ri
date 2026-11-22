import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleSource from '../support/example-source.ts';
import * as procedureActions from '../support/procedure-actions.ts';

// The names a configuration gives: those gg keeps for itself, and the forms a name may not take.
// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

// A rescue's or a rollback's reset, and an Interrupted Attempt's rescue and reset (#68), are gg's own Actions of the
// Visit: a declared agent Action of that name would share its marker, and the reset would read as already done.
for (const id of ['reset', 'interrupted-rescue', 'interrupted-reset'])
  test(`an Action id gg keeps for itself is an error: ${id}`, () => {
    const config = exampleSource.config();
    config.procedures['tests-fail'].actions[0].id = id;
    const refused = exampleSource
      .check(config)
      .errors.filter((problem) => problem.at === 'procedures.tests-fail.actions[0]');
    assert.deepEqual(exampleSource.firedRules(refused), [
      { at: 'procedures.tests-fail.actions[0]', code: 'reserved-name' },
    ]);
    assert.deepEqual(refused[0]!.params, { name: id });
  });

test('a Claim token named failed or harness-timeout is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures['tests-fail'].claimTokens, ['failed'], { stop: true });
  exampleSource.putAt(config.procedures['tests-fail'].claimTokens, ['harness-timeout'], { stop: true });
  const files = exampleSource.schemas();
  exampleSource.putAt(
    files['red.schema.json'],
    ['properties', 'claim', 'enum'],
    ['ok', 'blocked', 'failed', 'harness-timeout'],
  );
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config, files).errors), [
    {
      at: 'procedures.tests-fail.claimTokens.failed',
      code: 'reserved-name',
    },
    {
      at: 'procedures.tests-fail.claimTokens.harness-timeout',
      code: 'reserved-name',
    },
  ]);
});

test('a table outcome or otherwise named after an end is an error', () => {
  const config = exampleSource.config();
  config.procedures.review.otherwise = 'needs-replan';
  config.procedures['tests-fail'].stopped[0].outcome = 'needs-human';
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    {
      at: 'procedures.tests-fail.stopped[0]',
      code: 'reserved-name',
    },
    {
      at: 'procedures.review.otherwise',
      code: 'reserved-name',
    },
  ]);
});

// Each form a carried name may not take, named for the case.
const CARRIED_BREAKS = [
  ['', 'that is empty'],
  ['a:b', 'with a colon'],
  ['a.b', 'with a dot'],
  ['a b', 'with whitespace'],
  ['a/b', 'with a slash'],
  ['a--b', 'with a double hyphen'],
];
// Each form any other configured name may not take.
const BLANK_BREAKS = [
  ['', 'empty'],
  [' ', 'only whitespace'],
];

for (const [id, form] of CARRIED_BREAKS) {
  test(`an Action id ${form} is an error`, () => {
    const config = exampleSource.config();
    procedureActions.actionById(config.procedures['base-check'], 'test').id = id;
    assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
      { at: 'procedures.base-check.actions[0]', code: 'invalid-name' },
    ]);
  });
}

// A second Flow of one Vertex, whose id the case chooses, running the example's base-check.
const oneVertexFlow = (id: string) => ({
  actionCap: 1,
  ticket: { entry: id, vertices: { [id]: { procedure: 'base-check', route: { ok: { end: 'needs-human' } } } } },
});

for (const [id, form] of CARRIED_BREAKS) {
  test(`a Vertex id ${form} is an error at its location`, () => {
    const config = exampleSource.config();
    exampleSource.putAt(config.flows, ['names'], oneVertexFlow(id));
    assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
      { at: `flows.names.ticket.vertices.${id}`, code: 'invalid-name' },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`a Procedure name ${form} is an error at its location`, () => {
    const config = exampleSource.config();
    exampleSource.putAt(config.procedures, [name], config.procedures['base-check']);
    config.flows.default.ticket.vertices.baseline.procedure = name;
    assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
      { at: `procedures.${name}`, code: 'invalid-name' },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`an input name ${form} is an error at its location`, () => {
    const config = exampleSource.config();
    exampleSource.putAt(config.flows.default.ticket.vertices['implementer-fix'].inputs, [name], {
      from: 'red.commit.files',
    });
    const inputLocation = `flows.default.ticket.vertices.implementer-fix.inputs.${name}`;
    assert.deepEqual(
      exampleSource.firedRules(exampleSource.check(config).errors.filter((problem) => problem.at === inputLocation)),
      [{ at: inputLocation, code: 'invalid-name' }],
    );
  });
}

for (const [name, form] of BLANK_BREAKS) {
  test(`an Agent or Flow name that is ${form} is an error at its location`, () => {
    const config = exampleSource.config();
    exampleSource.putAt(config.agents, [name], config.agents.senior);
    exampleSource.putAt(config.flows, [name], oneVertexFlow('only'));
    assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
      { at: `agents.${name}`, code: 'invalid-name' },
      { at: `flows.${name}`, code: 'invalid-name' },
    ]);
  });

  test(`a Claim token that is ${form} is an error at its location`, () => {
    const config = exampleSource.config();
    exampleSource.putAt(config.procedures['tests-fail'].claimTokens, [name], { stop: true });
    const tokenLocation = `procedures.tests-fail.claimTokens.${name}`;
    assert.deepEqual(
      exampleSource.firedRules(exampleSource.check(config).errors.filter((problem) => problem.at === tokenLocation)),
      [{ at: tokenLocation, code: 'invalid-name' }],
    );
  });
}

test('a Vertex named after an end, cleanup or done is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.flows.default.ticket.vertices, ['cleanup'], { procedure: 'base-check' });
  exampleSource.putAt(config.flows.default.ticket.vertices, ['done'], { procedure: 'base-check' });
  exampleSource.putAt(config.flows.default.ticket.vertices, ['needs-human'], { procedure: 'base-check' });
  exampleSource.putAt(config.flows.default.ticket.vertices, ['ready-for-qa'], { procedure: 'base-check' });
  exampleSource.putAt(config.flows.default.ticket.vertices, ['needs-replan'], { procedure: 'base-check' });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: `${VERTICES}.cleanup`, code: 'reserved-name' },
    { at: `${VERTICES}.done`, code: 'reserved-name' },
    { at: `${VERTICES}.needs-human`, code: 'reserved-name' },
    { at: `${VERTICES}.ready-for-qa`, code: 'reserved-name' },
    { at: `${VERTICES}.needs-replan`, code: 'reserved-name' },
  ]);
});
