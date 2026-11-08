// The validator's rules for an await-approval Action: its Decisions, its place in its Procedure, and the Outcomes and
// labels a Vertex that asks gets (X1, V4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

const MALFORMED: [string, (config: exampleLayer.Layer) => void, exampleLayer.FiredRule[]][] = [
  [
    'a Decision a Decide Label cannot carry',
    (config) => {
      config.procedures.publish.actions.push({ id: 'ask', do: 'await-approval', decisions: ['Approved', 'not ok'] });
    },
    [
      { at: 'procedures.publish.actions[3]', code: 'invalid-name' },
      { at: 'procedures.publish.actions[3]', code: 'invalid-name' },
    ],
  ],
  [
    'a Decision the engine reserves',
    (config) => {
      config.procedures.publish.actions.push({
        id: 'ask',
        do: 'await-approval',
        decisions: ['failed', 'needs-human', 'harness-timeout'],
      });
    },
    [
      { at: 'procedures.publish.actions[3]', code: 'reserved-name' },
      { at: 'procedures.publish.actions[3]', code: 'reserved-name' },
      { at: 'procedures.publish.actions[3]', code: 'reserved-name' },
    ],
  ],
  [
    'an await-approval that is not the last Action',
    (config) => {
      config.procedures.publish.actions.splice(2, 0, { id: 'ask', do: 'await-approval' });
    },
    [{ at: 'procedures.publish.actions[2]', code: 'await-approval-not-last' }],
  ],
  [
    'an await-approval in a Procedure with an agent Action',
    (config) => {
      config.procedures.implement.actions.push({ id: 'ask', do: 'await-approval' });
    },
    [{ at: 'procedures.implement.actions[5]', code: 'await-approval-with-agent' }],
  ],
];

for (const [what, mutate, errors] of MALFORMED) {
  test(`an await-approval is rejected for ${what}`, () => {
    const config = exampleLayer.config();
    mutate(config);
    const found = exampleLayer.check(config).errors.map(({ at, code }) => ({ at, code }));
    assert.deepEqual(found, errors);
  });
}

// The example with a Vertex that asks a human, through the Action `ask`.
function askingConfig(ask: Record<string, unknown> = { id: 'ask', do: 'await-approval' }) {
  const config = exampleLayer.config();
  config.procedures.approval = { actions: [ask] };
  config.flows.default.ticket.vertices.approve = {
    procedure: 'approval',
    route: { approved: { end: 'needs-human' }, rejected: { end: 'needs-replan' } },
  };
  return config;
}

test("await-approval's decisions default to approved and rejected, and are the Procedure's Outcomes", () => {
  const { flows, errors } = exampleLayer.check(askingConfig());
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.approve.outcomes, ['approved', 'rejected']);
});

test('a declared Decision that no route takes is an unrouted Outcome', () => {
  const config = askingConfig({ id: 'ask', do: 'await-approval', decisions: ['approved', 'deferred'] });
  delete config.flows.default.ticket.routes['*'];
  const { errors } = exampleLayer.check(config);
  assert.ok(
    errors.some(({ at, code }) => at === `${VERTICES}.approve` && code === 'unrouted-outcome'),
    JSON.stringify(errors),
  );
});

test('a failing Check before an await-approval gives failed beside the Decisions', () => {
  const config = askingConfig();
  config.procedures.approval!.actions.unshift({ id: 'gate', do: 'check', kind: 'command', command: 'test' });
  const { flows, errors } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.approve.outcomes, ['approved', 'rejected', 'failed']);
});

test('the Resolved Flow lists the Await and Decide Labels of a Vertex that asks, and none for any other', () => {
  const { flows } = exampleLayer.check(askingConfig());
  assert.deepEqual(flows.default.ticket.vertices.approve.approvalLabels, {
    await: 'gg:await:approve',
    decide: ['gg:decide:approve:approved', 'gg:decide:approve:rejected'],
  });
  assert.equal(flows.default.ticket.vertices.red.approvalLabels, null);
});

test('the Resolved Flow names the Await and Decide Labels under the configured prefix', () => {
  const config = { ...askingConfig(), labelPrefix: 'x' };
  const { flows } = exampleLayer.check(config);
  assert.equal(flows.default.ticket.vertices.approve.approvalLabels?.await, 'x:await:approve');
});

test('a passed table beside an await-approval never applies: a Decision is the Outcome', () => {
  const config = askingConfig();
  config.procedures.approval!.passed = [{ when: { pass: 1 }, outcome: 'never' }];
  const found = exampleLayer.check(config).errors.map(({ at, code }) => ({ at, code }));
  assert.deepEqual(found, [{ at: 'procedures.approval.passed', code: 'table-never-applies' }]);
});

test('a Decision named after an Object.prototype property is an Outcome like any other', () => {
  const config = askingConfig({ id: 'ask', do: 'await-approval', decisions: ['constructor', 'rejected'] });
  config.flows.default.ticket.vertices.approve.route = { constructor: { end: 'needs-human' } };
  const { flows, errors } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.approve.outcomes, ['constructor', 'rejected']);
  assert.deepEqual(flows.default.ticket.vertices.approve.approvalLabels?.decide, [
    'gg:decide:approve:constructor',
    'gg:decide:approve:rejected',
  ]);
});

test('a repeated Decision is reported', () => {
  const config = askingConfig({ id: 'ask', do: 'await-approval', decisions: ['approved', 'approved', 'rejected'] });
  const found = exampleLayer.check(config).errors.map(({ at, code }) => ({ at, code }));
  assert.deepEqual(found, [{ at: 'procedures.approval.actions[0]', code: 'repeated-decision' }]);
});

test('otherwise beside an await-approval with no Check before it is reported: nothing can fail', () => {
  const config = askingConfig();
  config.procedures.approval!.otherwise = 'approved';
  const found = exampleLayer.check(config).errors.map(({ at, code }) => ({ at, code }));
  assert.deepEqual(found, [{ at: 'procedures.approval.otherwise', code: 'invalid-otherwise' }]);
});

test('otherwise beside an await-approval with a Check before it names the failed Outcome, and is kept', () => {
  const config = askingConfig();
  config.procedures.approval!.actions.unshift({ id: 'gate', do: 'check', kind: 'command', command: 'test' });
  config.procedures.approval!.otherwise = 'rejected';
  const { flows, errors } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.approve.outcomes, ['approved', 'rejected']);
});

test('a repeated Decision is reported beside every other mistake in its list', () => {
  const config = askingConfig({ id: 'ask', do: 'await-approval', decisions: ['failed', 'failed', 'Needs-Work'] });
  const found = exampleLayer.check(config).errors.map(({ code }) => code);
  assert.deepEqual(found, ['repeated-decision', 'reserved-name', 'invalid-name']);
});
