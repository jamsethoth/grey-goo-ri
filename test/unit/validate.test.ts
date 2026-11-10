import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as validate from '../../lib/validate/index.ts';
import * as report from '../../lib/validate/report.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as namedFlow from '../support/named-flow.ts';
import * as procedureActions from '../support/procedure-actions.ts';
import * as requestTables from '../support/request-tables.ts';

// A case about a rule asserts which one fired and where: a Problem's `code` and `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('every Problem code is one closed list of readable kebab-case names, not decision ids', () => {
  // @ts-expect-error -- a decision id is not a listed code, so report.error would not take it
  const decisionId: report.ProblemCode = 'H7';
  assert.equal(report.PROBLEM_CODES.includes(decisionId), false);
  assert.deepEqual(
    report.PROBLEM_CODES.filter((code) => !/^[a-z]+(-[a-z]+)+$/.test(code)),
    [],
  );
});

test('a Problem carries its code beside its location and message', () => {
  const problems = report.newReport();
  report.error(problems, 'flows', 'no-flow-declared', 'an error');
  report.warn(problems, 'agents.spare', 'unused-agent', 'a warning', { agent: 'spare' });
  assert.deepEqual(problems, {
    errors: [{ at: 'flows', code: 'no-flow-declared', message: 'an error' }],
    warnings: [{ at: 'agents.spare', code: 'unused-agent', message: 'a warning', params: { agent: 'spare' } }],
  });
});

// The example with an owner-questions Vertex between baseline and red that asks and is answered, and red's input
// `answers` reading `source`.
const askedBeforeRed = (source: string) => {
  const config = exampleLayer.config();
  config.procedures['ask-owner'] = { actions: [{ id: 'ask', do: 'await-approval', decisions: ['answered'] }] };
  config.flows.default.ticket.vertices.baseline.route = { ok: 'owner-questions' };
  config.flows.default.ticket.vertices['owner-questions'] = { procedure: 'ask-owner', route: { answered: 'red' } };
  config.flows.default.ticket.vertices.red.inputs.answers = { from: source };
  return exampleLayer.check(config);
};

test("an input from an await-approval Action's decision.reply is accepted", () => {
  for (const field of ['reply', 'outcome', 'actor']) {
    const { errors, warnings } = askedBeforeRed(`owner-questions.ask.decision.${field}`);
    assert.deepEqual(exampleLayer.firedRules(errors), [], `decision.${field}`);
    assert.deepEqual(
      warnings.filter((warning) => warning.at.includes('owner-questions') || warning.at.endsWith('red.inputs.answers')),
      [],
    );
  }
  const unknown = askedBeforeRed('owner-questions.ask.decision.replies').errors;
  assert.deepEqual(exampleLayer.firedRules(unknown), [
    { at: `${VERTICES}.red.inputs.answers`, code: 'undefined-reference' },
  ]);
});

test('the example Flow resolves with no errors', () => {
  const { errors } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(errors, []);
});

test("the example Flow warns only of the review table's two intended overlaps", () => {
  const { warnings } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(exampleLayer.firedRules(warnings), [
    { at: 'procedures.review.passed', code: 'overlapping-rows' },
    { at: 'procedures.review.passed', code: 'overlapping-rows' },
  ]);
  assert.deepEqual(
    warnings.map(
      ({ params }) =>
        params &&
        'rows' in params && {
          table: params.table,
          rows: params.rows,
          earlier: params.earlier,
          conditions: params.conditions.map(({ row }) => row),
        },
    ),
    [
      { table: 'review.passed', rows: [1, 1], earlier: [[0, 0]], conditions: [1, 0] },
      { table: 'review.passed', rows: [2, 2], earlier: [[0, 1]], conditions: [2, 0, 1] },
    ],
  );
});

test("the Resolved Flow carries each Vertex's Agent, Procedure, access, tests and Outcomes", () => {
  const { flows } = exampleLayer.check(exampleLayer.config());
  assert.equal(flows.default.actionCap, 180);
  assert.equal(Object.hasOwn(flows.default, 'plan'), false, 'a Flow has no plan');
  assert.equal(flows.default.ticket.entry, 'baseline');
  const red = flows.default.ticket.vertices.red;
  assert.deepEqual(red.agent, {
    persona: 'implementer.md',
    access: 'workspace-write',
    harness: 'fake',
    model: null,
    effort: null,
  });
  assert.equal(red.procedure, 'tests-fail');
  assert.equal(red.access, 'workspace-write');
  assert.equal(red.tests, 'write');
  assert.deepEqual(red.outcomes, [
    'ok',
    'failed',
    'misscoped',
    'no-test',
    'blocked',
    'harness-timeout',
    'harness-transient',
    'harness-unparsed',
  ]);
  assert.deepEqual(flows.default.ticket.vertices.reviewer.outcomes, [
    'ok',
    'repeat',
    'retest',
    'changes',
    'misscoped',
    'blocked',
    'harness-timeout',
    'harness-transient',
    'harness-unparsed',
  ]);
  assert.deepEqual(flows.default.ticket.vertices.publish.outcomes, ['ok', 'failed']);
});

// The digest is sha256 of
// '{"actions":[{"command":"test","do":"check","id":"test","kind":"command","reuse":"tree"}],"failed":[],"passed":[]}'.
test("a Procedure's hash is the sha256 of its canonical JSON as declared, whatever its key order", () => {
  const config = exampleLayer.config();
  config.procedures['base-check'] = {
    passed: [],
    failed: [],
    actions: [{ reuse: 'tree', kind: 'command', id: 'test', do: 'check', command: 'test' }],
  };
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.equal(
    flows.default.procedures['base-check'].hash,
    '4929e4d499e9975dfedf3bd83b200523d9cb06c8f5b9d30416a9fbf924226e79',
  );
});

test('a Procedure with no agent Action has the implicit Claim ok requiring every Check', () => {
  const { flows } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(flows.default.procedures.publish.claimTokens, { ok: { requires: ['test'] } });
  assert.equal(flows.default.ticket.vertices.publish.agent, null);
});

test('a Procedure with no agent Action that declares claimTokens is an error', () => {
  const config = exampleLayer.config();
  config.procedures['base-check'].claimTokens = { ok: { requires: ['test'] } };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.base-check.claimTokens',
      code: 'claim-tokens-without-agent-action',
    },
  ]);
});

test('access: read-only on the Procedure caps the Agent', () => {
  const config = exampleLayer.config();
  config.agents.reviewer.access = 'workspace-write';
  const { errors, flows } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.vertices.reviewer.agent?.access, 'workspace-write');
  assert.equal(flows.default.ticket.vertices.reviewer.access, 'read-only');
});

test("a Vertex's own access outside the Permission Intents is an error at the Vertex", () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.green.access = 'read-write';
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: `${VERTICES}.green.access`,
      code: 'unknown-permission-intent',
    },
  ]);
});

// A rescue's or a rollback's reset is gg's own Action of the Visit: a declared agent Action of that name would share
// its marker, and the reset would read as already done.
test('an Action id gg keeps for itself is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].actions[0].id = 'reset';
  const refused = exampleLayer
    .check(config)
    .errors.filter((problem) => problem.at === 'procedures.tests-fail.actions[0]');
  assert.deepEqual(exampleLayer.firedRules(refused), [
    { at: 'procedures.tests-fail.actions[0]', code: 'reserved-name' },
  ]);
  assert.deepEqual(refused[0]!.params, { name: 'reset' });
});

test('a Claim token named failed or harness-timeout is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].claimTokens.failed = { stop: true };
  config.procedures['tests-fail'].claimTokens['harness-timeout'] = { stop: true };
  const files = exampleLayer.schemas();
  files['red.schema.json'].properties.claim.enum = ['ok', 'blocked', 'failed', 'harness-timeout'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config, files).errors), [
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
  const config = exampleLayer.config();
  config.procedures.review.otherwise = 'needs-replan';
  config.procedures['tests-fail'].stopped[0].outcome = 'needs-human';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
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
    const config = exampleLayer.config();
    procedureActions.actionById(config.procedures['base-check'], 'test').id = id;
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
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
    const config = exampleLayer.config();
    config.flows.names = oneVertexFlow(id);
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
      { at: `flows.names.ticket.vertices.${id}`, code: 'invalid-name' },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`a Procedure name ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.procedures[name] = config.procedures['base-check'];
    config.flows.default.ticket.vertices.baseline.procedure = name;
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
      { at: `procedures.${name}`, code: 'invalid-name' },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`an input name ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.flows.default.ticket.vertices['implementer-fix'].inputs[name] = { from: 'red.commit.files' };
    const inputLocation = `flows.default.ticket.vertices.implementer-fix.inputs.${name}`;
    assert.deepEqual(
      exampleLayer.firedRules(exampleLayer.check(config).errors.filter((problem) => problem.at === inputLocation)),
      [{ at: inputLocation, code: 'invalid-name' }],
    );
  });
}

for (const [name, form] of BLANK_BREAKS) {
  test(`an Agent or Flow name that is ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.agents[name] = config.agents.senior;
    config.flows[name] = oneVertexFlow('only');
    assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
      { at: `agents.${name}`, code: 'invalid-name' },
      { at: `flows.${name}`, code: 'invalid-name' },
    ]);
  });

  test(`a Claim token that is ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.procedures['tests-fail'].claimTokens[name] = { stop: true };
    const tokenLocation = `procedures.tests-fail.claimTokens.${name}`;
    assert.deepEqual(
      exampleLayer.firedRules(exampleLayer.check(config).errors.filter((problem) => problem.at === tokenLocation)),
      [{ at: tokenLocation, code: 'invalid-name' }],
    );
  });
}

// Without a Flow, the validator gg doctor and gg run share names gg init (P1a).
test('a configuration without a Flow names gg init', () => {
  const config = exampleLayer.config();
  delete config.flows;
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [{ at: 'flows', code: 'no-flow-declared' }]);
  assert.equal(
    errors[0].message,
    "no Flow is declared; run gg init to write the example Flow into the repository's .agents/gg/",
  );
});

test('a repeated Action id is an error', () => {
  const config = exampleLayer.config();
  const pr = procedureActions.actionById(config.procedures.publish, 'pr');
  pr.id = 'test';
  pr.do = 'push';
  delete pr.body;
  delete pr.with;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.publish.actions[1]', code: 'repeated-action-id' },
  ]);
});

test('a second agent Action in a Procedure is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.actions.push({ id: 'again', do: 'agent', brief: 'review.md', schema: 'review.schema.json' });
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.review.actions[5]', code: 'second-agent-action' },
  ]);
});

test('an unknown key is an error naming it', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.rout = {};
  procedureActions.actionById(config.procedures.publish, 'pr-ready').draft = true;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.publish.actions[2]', code: 'unknown-key' },
    { at: `${VERTICES}.red`, code: 'unknown-key' },
  ]);
});

test('an unknown Action kind or Check kind is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.publish, 'pr-ready').do = 'merge';
  procedureActions.actionById(config.procedures['base-check'], 'test').kind = 'changes';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    {
      at: 'procedures.base-check.actions[0]',
      code: 'unknown-check-kind',
    },
    {
      at: 'procedures.publish.actions[2]',
      code: 'unknown-action-kind',
    },
  ]);
});

test('a token requiring an Action that is not a Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.implement.claimTokens.ok.requires = ['commit'];
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.implement.claimTokens.ok', code: 'undeclared-check' },
  ]);
});

test('a Vertex naming an undeclared Procedure or Agent is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  config.flows.default.ticket.vertices.green.use = 'coder';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'undeclared-procedure' },
    { at: `${VERTICES}.green`, code: 'undeclared-agent' },
  ]);
});

test('an agent Procedure on a Vertex with no Agent, or an Agent on an agentless one, is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.vertices.red.use;
  config.flows.default.ticket.vertices.publish.use = 'implementer';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'vertex-needs-agent' },
    { at: `${VERTICES}.publish`, code: 'vertex-takes-no-agent' },
  ]);
});

test('an Agent with no harness or an unregistered one is an error', () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.harness;
  config.agents.senior.harness = 'other';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.reviewer', code: 'harness-unset' },
    { at: 'agents.senior', code: 'harness-unregistered' },
  ]);
});

test("an Agent with no harness is one error at the Agent, which a Vertex's own harness does not excuse", () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.harness;
  delete config.agents.senior.harness;
  config.flows.default.ticket.vertices.reviewer.harness = 'fake';
  delete config.flows.default.ticket.vertices.red.use;
  config.flows.default.ticket.vertices.red.model = 'opus';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.reviewer', code: 'harness-unset' },
    { at: 'agents.senior', code: 'harness-unset' },
    {
      at: `${VERTICES}.red`,
      code: 'harness-unset',
    },
  ]);
});

test('an empty Agent is one error at the Agent, not one per Vertex that uses it', () => {
  const config = exampleLayer.config();
  config.agents.senior = {};
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.senior', code: 'harness-unset' },
  ]);
});

test('an unused Agent naming an unregistered harness is an error', () => {
  const config = exampleLayer.config();
  config.agents.spare = { persona: 'implementer.md', harness: 'other' };
  config.agents.blank = 'spare.md';
  config.agents.bare = { persona: 'implementer.md' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.spare', code: 'harness-unregistered' },
    { at: 'agents.blank', code: 'not-an-object' },
    { at: 'agents.bare', code: 'harness-unset' },
  ]);
});

test('an Agent no Vertex uses is a warning', () => {
  const config = exampleLayer.config();
  config.agents.spare = { persona: 'implementer.md', harness: 'fake' };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleLayer.firedRules(warnings.filter((warning) => warning.at.startsWith('agents.'))), [
    { at: 'agents.spare', code: 'unused-agent' },
  ]);
});

test("an Agent's error is reported once however many Vertices use it", () => {
  const config = exampleLayer.config();
  config.agents.senior.harness = 'other';
  config.flows.default.ticket.vertices['senior-dev'].harness = 'missing';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.senior', code: 'harness-unregistered' },
    { at: `${VERTICES}.senior-dev`, code: 'harness-unregistered' },
  ]);
});

test('a Vertex named after an end, cleanup or done is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.cleanup = { procedure: 'base-check' };
  config.flows.default.ticket.vertices.done = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-human'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['ready-for-qa'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-replan'] = { procedure: 'base-check' };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.cleanup`, code: 'reserved-name' },
    { at: `${VERTICES}.done`, code: 'reserved-name' },
    { at: `${VERTICES}.needs-human`, code: 'reserved-name' },
    { at: `${VERTICES}.ready-for-qa`, code: 'reserved-name' },
    { at: `${VERTICES}.needs-replan`, code: 'reserved-name' },
  ]);
});

// A Flow has no plan key: a planning Flow is a Flow run at Epic level, request slice 7's design (#298).
test('a Flow with a plan key, or without a positive actionCap, is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.actionCap = 0;
  config.flows.light = {
    plan: null,
    actionCap: 20,
    ticket: { entry: 'baseline', vertices: { baseline: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'flows.light.plan', code: 'null-value' },
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: 'flows.light', code: 'unknown-key' },
  ]);
});

// In a configuration file null is never a value (#298): one pass reports each null at its path, and the checks of the
// key it sits on still run on it, so a null may be reported twice. A missing key is a different thing.
test('a null anywhere in the configuration is reported at its path, beside the rule the key breaks', () => {
  const config = exampleLayer.config();
  config.agents.reviewer = null;
  config.agents.implementer.harness = null;
  config.flows.default.ticket.entry = null;
  config.flows.default.ticket.vertices.red.procedure = null;
  config.flows.default.ticket.vertices.green.model = null;
  config.procedures['tests-fail'].actions[1] = null;
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(
    errors.filter((problem) => problem.code === 'null-value').map((problem) => problem.at),
    [
      'agents.implementer.harness',
      'agents.reviewer',
      'procedures.tests-fail.actions[1]',
      'flows.default.ticket.entry',
      'flows.default.ticket.vertices.red.procedure',
      'flows.default.ticket.vertices.green.model',
    ],
  );
  assert.equal(errors[0].message, 'null is not a value in a configuration file; set a value or leave the key out');
  assert.ok(
    errors.some((problem) => problem.at === 'agents.reviewer' && problem.code === 'not-an-object'),
    'the key its own check reports too',
  );
  assert.equal(
    errors.some((problem) => problem.code === 'harness-unset' || problem.code === 'harness-unregistered'),
    false,
    'a null harness is neither unset nor a harness to look up',
  );
});

// Null errors are not shared errors: they hold no Flow's graph checks, since the key's own check already holds the
// Flow a null breaks.
test("a null does not hold another Flow's graph checks", () => {
  const config = exampleLayer.config();
  config.agents.spare = { persona: 'implementer.md', harness: null };
  config.flows.default.ticket.vertices.green.model = null;
  config.flows.light = { actionCap: 1, ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } } };
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.spare.harness', code: 'null-value' },
    { at: 'flows.default.ticket.vertices.green.model', code: 'null-value' },
    { at: 'agents.spare', code: 'invalid-name' },
    { at: 'flows.light.ticket.vertices.gate', code: 'unrouted-outcome' },
  ]);
});

// A harness is a name the registry is asked for; a value of another shape is never looked up.
test('a harness that is not a name is an invalid name, not an unregistered harness', () => {
  const config = exampleLayer.config();
  config.agents.implementer.harness = 7;
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [{ at: 'agents.implementer', code: 'invalid-name' }]);
  assert.equal(errors[0].message, "agent implementer's harness 7 must not be empty or only whitespace");
});

test('a present null id is a wrong value, so a Check still prints it', () => {
  const config = exampleLayer.config();
  const check = procedureActions.actionById(config.procedures['base-check'], 'test');
  check.id = null;
  delete check.command;
  assert.deepEqual(
    exampleLayer.check(config).errors.map((problem) => problem.message),
    [
      'null is not a value in a configuration file; set a value or leave the key out',
      'Action id null must be non-empty with no ":", ".", "/", "--" or whitespace',
      'Check null must name a command',
    ],
  );
});

test('a configuration that is not an object is one error, not a throw', () => {
  const { flows, errors, warnings } = validate.validate(null, { harnesses: {}, readSchema: () => ({}) });
  assert.deepEqual(
    { flows, errors: exampleLayer.firedRules(errors), warnings },
    { flows: {}, errors: [{ at: '', code: 'not-an-object' }], warnings: [] },
  );
});

// A pass is the agent Action and the Checks after it (T4, R1a): every Check runs before any effect, so a commit or
// pr-ready counts only Checks that ran (Q3a), and no effect runs for a Visit that then stops or fails (Q3).

// The example's implement Actions by id, so each order case lists every Action of the order it builds.
const implementActions = (config: exampleLayer.Layer) =>
  ['green', 'test', 'commit', 'push', 'pr'].map((id) => procedureActions.actionById(config.procedures.implement, id));

test('a Check after an effect Action is an error', () => {
  const config = exampleLayer.config();
  const [green, check, commit, push, pr] = implementActions(config);
  config.procedures.implement.actions = [green, commit, check, push, pr];
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.implement.actions[2]',
      code: 'check-after-effect',
    },
  ]);
});

test('an agent Action after a Check is an error', () => {
  const config = exampleLayer.config();
  const [green, check, commit, push, pr] = implementActions(config);
  config.procedures.implement.actions = [check, green, commit, push, pr];
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.implement.actions[1]',
      code: 'agent-action-not-first',
    },
  ]);
});

test('a comment between the agent Action and its Checks is an error', () => {
  const config = exampleLayer.config();
  const [green, check, commit, push, pr] = implementActions(config);
  const note = { id: 'note', do: 'comment', target: 'ticket', body: 'note.md' };
  config.procedures.implement.actions = [green, note, check, commit, push, pr];
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.implement.actions[2]',
      code: 'check-after-effect',
    },
  ]);
});

test('a commit in a Procedure with no agent Action is an error', () => {
  const config = exampleLayer.config();
  config.procedures['base-check'].actions.push({ id: 'commit', do: 'commit', type: 'chore' });
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(exampleLayer.firedRules(errors), [
    {
      at: 'procedures.base-check.actions[1]',
      code: 'needs-agent-action',
    },
  ]);
});

test("a Vertex's maxVisits is an unknown key: its Bound is max, as on an edge", () => {
  const config = exampleLayer.config();
  const vertex = config.flows.default.ticket.vertices['senior-dev'];
  vertex.maxVisits = vertex.max;
  delete vertex.max;
  delete vertex.exhausted;
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: `${VERTICES}.senior-dev`, code: 'unknown-key' },
  ]);
});

// The configuration keys #229 renamed: a Layer still written with an old key fails admission as any unknown key does.
const oldKeyOf = (action: Record<string, unknown>, oldKey: string, newKey: string) => {
  action[oldKey] = action[newKey] ?? action[oldKey];
  delete action[newKey];
};
const actionOf = (config: exampleLayer.Layer, procedure: string, kind: string) =>
  config.procedures[procedure].actions.find((action: { kind: string }) => action.kind === kind);
const RENAMED_KEYS: [string, (config: exampleLayer.Layer) => unknown, string][] = [
  [
    'all-of',
    (config) => oldKeyOf(actionOf(config, 'review', 'response'), 'all-of', 'allOf'),
    'procedures.review.actions[1]',
  ],
  [
    'names',
    (config) => oldKeyOf(actionOf(config, 'tests-fail', 'tests-fail'), 'names', 'testNames'),
    'procedures.tests-fail.actions[1]',
  ],
  ['claims', (config) => oldKeyOf(config.procedures.review, 'claims', 'claimTokens'), 'procedures.review'],
  ['resolution', (config) => (config.agents.implementer.resolution = { transient: 1 }), 'agents.implementer'],
  [
    'resolution',
    (config) => (config.flows.default.ticket.vertices.red.resolution = { transient: 1 }),
    `${VERTICES}.red`,
  ],
];
for (const [oldKey, write, location] of RENAMED_KEYS) {
  test(`a Layer written with a renamed key fails admission as an unknown key: ${oldKey} at ${location}`, () => {
    const config = exampleLayer.config();
    write(config);
    const unknown = exampleLayer.check(config).errors.filter((problem) => problem.code === 'unknown-key');
    assert.deepEqual(exampleLayer.firedRules(unknown), [{ at: location, code: 'unknown-key' }]);
  });
}

test('an Agent with a key no Agent declares is an error at agents.<name>', () => {
  const config = exampleLayer.config();
  config.agents.reviewer.modle = 'opus';
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'agents.reviewer', code: 'unknown-key' },
  ]);
});

test('an Agent and a Vertex may declare a resolutionPolicy', () => {
  const config = exampleLayer.config();
  config.agents.implementer.resolutionPolicy = { transient: 1 };
  config.flows.default.ticket.vertices.red.resolutionPolicy = { transient: 1 };
  assert.deepEqual(exampleLayer.check(config).errors, []);
});

// The request's key tables a Layer's author reads list exactly the keys the validator accepts (#229).
test("the request's Flow table lists exactly the keys of a Flow, its ticket, Vertices, routes and inputs", () => {
  assert.deepEqual(
    requestTables.keyTable('Flow object'),
    requestTables.sortedKeys({
      'flows.<name>': validate.FLOW_KEYS,
      ticket: validate.TICKET_KEYS,
      'vertices.<id>': validate.VERTEX_KEYS,
      'route.<outcome>': validate.EDGE_KEYS,
      'inputs.<name>': validate.INPUT_KEYS,
    }),
  );
});

test("the request's Procedure table lists exactly the keys of a Procedure and a Claim token", () => {
  assert.deepEqual(
    requestTables.keyTable('Procedure object'),
    requestTables.sortedKeys({
      'procedures.<name>': validate.PROCEDURE_KEYS,
      'claimTokens.<token>': Object.values(validate.CLAIM_TOKEN_FORMS).flat(),
    }),
  );
});

test("the request's Agent table lists exactly the keys an Agent accepts", () => {
  assert.deepEqual(requestTables.firstColumn('| Field | Meaning |'), [...validate.AGENT_KEYS].sort());
});

// A Procedure's hash is of the Procedure as declared, names and all, so a case comparing two namings leaves it out.
const withoutHashes = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, item: unknown) => (key === 'hash' ? undefined : item)));

test('a Flow named entirely with Object.prototype names resolves like one with ordinary names', () => {
  const ordinary = namedFlow.validated(namedFlow.ORDINARY);
  assert.deepEqual([...ordinary.errors, ...ordinary.warnings], []);
  const prototype = namedFlow.validated(namedFlow.PROTOTYPE);
  assert.deepEqual(
    withoutHashes({ ...prototype, flows: Object.entries(prototype.flows) }),
    withoutHashes(namedFlow.renamed({ ...ordinary, flows: Object.entries(ordinary.flows) })),
  );
});

test('an Action id that is an object is an error, never a throw', () => {
  const config = exampleLayer.config();
  // A Procedure with no agent Action, whose implicit Claim ok requires every Check.
  config.procedures['base-check'].actions[0].id = JSON.parse('{"toString": 1}');
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.base-check.actions[0]', code: 'invalid-name' },
  ]);
});

test('an otherwise that is an object is an error, never a throw', () => {
  const config = exampleLayer.config();
  config.procedures.review.otherwise = JSON.parse('{"toString": 1}');
  assert.deepEqual(exampleLayer.firedRules(exampleLayer.check(config).errors), [
    { at: 'procedures.review.otherwise', code: 'invalid-otherwise' },
  ]);
});

// Each slot the configuration names something in, given a value that is not a string (an object whose toString is not
// callable, so a property key or a route lookup made of it would throw): the validator reports it at its location and
// keeps it out of every collection and route (#174).
const REJECTED_NAME = '{"toString": 1}';
const REJECTED_SLOTS: [string, (config: exampleLayer.Layer, value: unknown) => void, string][] = [
  ['an Action id', (config, value) => (config.procedures['base-check'].actions[0].id = value), 'procedures.base-check'],
  ['an otherwise', (config, value) => (config.procedures.review.otherwise = value), 'procedures.review'],
  ['a table outcome', (config, value) => (config.procedures.review.passed[0].outcome = value), 'procedures.review'],
  [
    'a Decision',
    (config, value) => {
      config.procedures.approval = { actions: [{ id: 'ask', do: 'await-approval', decisions: [value] }] };
      config.flows.default.ticket.vertices.approve = { procedure: 'approval', route: {} };
    },
    'procedures.approval',
  ],
];
for (const [what, mutate, location] of REJECTED_SLOTS) {
  test(`${what} that is not a string is reported at its location and never thrown on`, () => {
    const config = exampleLayer.config();
    mutate(config, JSON.parse(REJECTED_NAME));
    const { errors } = exampleLayer.check(config);
    assert.ok(
      errors.some((problem) => problem.at.startsWith(location)),
      `an error at ${location}, got ${JSON.stringify(exampleLayer.firedRules(errors))}`,
    );
  });
}
