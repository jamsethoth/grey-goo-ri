import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as referencePaths from '../../lib/reference-paths.ts';
import * as validate from '../../lib/validate/index.ts';
import * as report from '../../lib/validate/report.ts';
import * as exampleSource from '../support/example-source.ts';
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
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures, ['ask-owner'], {
    actions: [{ id: 'ask', do: 'await-approval', decisions: ['answered'] }],
  });
  config.flows.default.ticket.vertices.baseline.route = { ok: 'owner-questions' };
  exampleSource.putAt(config.flows.default.ticket.vertices, ['owner-questions'], {
    procedure: 'ask-owner',
    route: { answered: 'red' },
  });
  exampleSource.putAt(config.flows.default.ticket.vertices.red.inputs, ['answers'], { from: source });
  return exampleSource.check(config);
};

test("an input from an await-approval Action's decision.reply is accepted", () => {
  for (const field of ['reply', 'outcome', 'actor']) {
    const { errors, warnings } = askedBeforeRed(`owner-questions.ask.decision.${field}`);
    assert.deepEqual(exampleSource.firedRules(errors), [], `decision.${field}`);
    assert.deepEqual(
      warnings.filter((warning) => warning.at.includes('owner-questions') || warning.at.endsWith('red.inputs.answers')),
      [],
    );
  }
  const unknown = askedBeforeRed('owner-questions.ask.decision.replies').errors;
  assert.deepEqual(exampleSource.firedRules(unknown), [
    { at: `${VERTICES}.red.inputs.answers`, code: 'undefined-reference' },
  ]);
});

test('the example Flow resolves with no errors', () => {
  const { errors } = exampleSource.check(exampleSource.config());
  assert.deepEqual(errors, []);
});

test("the example Flow warns only of the review table's two intended overlaps", () => {
  const { warnings } = exampleSource.check(exampleSource.config());
  assert.deepEqual(exampleSource.firedRules(warnings), [
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
  const { flows } = exampleSource.check(exampleSource.config());
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
    'harness-handoff',
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
    'harness-handoff',
  ]);
  assert.deepEqual(flows.default.ticket.vertices.publish.outcomes, ['ok', 'failed']);
});

// The digest is sha256 of
// '{"actions":[{"command":"test","do":"check","id":"test","kind":"command","reuse":"tree"}],"failed":[],"passed":[]}'.
test("a Procedure's hash is the sha256 of its canonical JSON as declared, whatever its key order", () => {
  const config = exampleSource.config();
  config.procedures['base-check'] = {
    passed: [],
    failed: [],
    actions: [{ reuse: 'tree', kind: 'command', id: 'test', do: 'check', command: 'test' }],
  };
  const { errors, flows } = exampleSource.check(config);
  assert.deepEqual(errors, []);
  assert.equal(
    flows.default.procedures['base-check'].hash,
    '4929e4d499e9975dfedf3bd83b200523d9cb06c8f5b9d30416a9fbf924226e79',
  );
});

test('a Procedure with no agent Action has the implicit Claim ok requiring every Check', () => {
  const { flows } = exampleSource.check(exampleSource.config());
  assert.deepEqual(flows.default.procedures.publish.claimTokens, { ok: { requires: ['test'] } });
  assert.equal(flows.default.ticket.vertices.publish.agent, null);
});

test('a Procedure with no agent Action that declares claimTokens is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures['base-check'], ['claimTokens'], { ok: { requires: ['test'] } });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    {
      at: 'procedures.base-check.claimTokens',
      code: 'claim-tokens-without-agent-action',
    },
  ]);
});

test("a Vertex's own access outside the Permission Intents is an error at the Vertex", () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.flows.default.ticket.vertices.green, ['access'], 'read-write');
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    {
      at: `${VERTICES}.green.access`,
      code: 'unknown-permission-intent',
    },
  ]);
});

// Without a Flow, the validator gg doctor and gg run share names gg init (P1a).
test('a configuration without a Flow names gg init', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config, ['flows']);
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [{ at: 'flows', code: 'no-flow-declared' }]);
  assert.equal(
    errors[0].message,
    "no Flow is declared; run gg init to write the example Flow into the repository's .agents/gg/",
  );
});

test('a repeated Action id is an error', () => {
  const config = exampleSource.config();
  const pr = procedureActions.actionById(config.procedures.publish, 'pr');
  pr.id = 'test';
  pr.do = 'push';
  delete pr.body;
  delete pr.with;
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.publish.actions[1]', code: 'repeated-action-id' },
  ]);
});

test('a second agent Action in a Procedure is an error', () => {
  const config = exampleSource.config();
  config.procedures.review.actions.push({ id: 'again', do: 'agent', brief: 'review.md', schema: 'review.schema.json' });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.review.actions[5]', code: 'second-agent-action' },
  ]);
});

test('an unknown key is an error naming it', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['rout'], {});
  exampleSource.putAt(procedureActions.actionById(config.procedures.publish, 'pr-ready'), ['draft'], true);
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.publish.actions[2]', code: 'unknown-key' },
    { at: `${VERTICES}.red`, code: 'unknown-key' },
  ]);
});

test('an unknown Action kind or Check kind is an error', () => {
  const config = exampleSource.config();
  procedureActions.actionById(config.procedures.publish, 'pr-ready').do = 'merge';
  procedureActions.actionById(config.procedures['base-check'], 'test').kind = 'changes';
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
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
  const config = exampleSource.config();
  config.procedures.implement.claimTokens.ok.requires = ['commit'];
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.implement.claimTokens.ok', code: 'undeclared-check' },
  ]);
});

test('a Vertex naming an undeclared Procedure or Agent is an error', () => {
  const config = exampleSource.config();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  config.flows.default.ticket.vertices.green.use = 'coder';
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'undeclared-procedure' },
    { at: `${VERTICES}.green`, code: 'undeclared-agent' },
  ]);
});

test('an agent Procedure on a Vertex with no Agent, or an Agent on an agentless one, is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['use']);
  exampleSource.putAt(config.flows.default.ticket.vertices.publish, ['use'], 'implementer');
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: `${VERTICES}.red`, code: 'vertex-needs-agent' },
    { at: `${VERTICES}.publish`, code: 'vertex-takes-no-agent' },
  ]);
});

test('an Agent with no harness or an unregistered one is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.reviewer, ['harness']);
  config.agents.senior.harness = 'other';
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.reviewer', code: 'harness-unset' },
    { at: 'agents.senior', code: 'harness-unregistered' },
  ]);
});

test("an Agent with no harness is one error at the Agent, which a Vertex's own harness does not excuse", () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.reviewer, ['harness']);
  exampleSource.putAt(config.agents.senior, ['harness']);
  exampleSource.putAt(config.flows.default.ticket.vertices.reviewer, ['harness'], 'fake');
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['use']);
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['model'], 'opus');
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.reviewer', code: 'harness-unset' },
    { at: 'agents.senior', code: 'harness-unset' },
    { at: `${VERTICES}.red`, code: 'harness-unset' },
    { at: `${VERTICES}.red`, code: 'required-key-missing' },
  ]);
});

test('an empty Agent is one error at the Agent, not one per Vertex that uses it', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents, ['senior'], {});
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.senior', code: 'harness-unset' },
    { at: 'agents.senior', code: 'required-key-missing' },
  ]);
});

test('an unused Agent naming an unregistered harness is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents, ['spare'], { persona: 'implementer.md', harness: 'other' });
  exampleSource.putAt(config.agents, ['blank'], 'spare.md');
  exampleSource.putAt(config.agents, ['bare'], { persona: 'implementer.md' });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.spare', code: 'harness-unregistered' },
    { at: 'agents.blank', code: 'not-an-object' },
    { at: 'agents.bare', code: 'harness-unset' },
  ]);
});

test('an Agent no Vertex uses is a warning', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents, ['spare'], { persona: 'implementer.md', harness: 'fake' });
  const { errors, warnings } = exampleSource.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(exampleSource.firedRules(warnings.filter((warning) => warning.at.startsWith('agents.'))), [
    { at: 'agents.spare', code: 'unused-agent' },
  ]);
});

test("an Agent's error is reported once however many Vertices use it", () => {
  const config = exampleSource.config();
  config.agents.senior.harness = 'other';
  exampleSource.putAt(config.flows.default.ticket.vertices['senior-dev'], ['harness'], 'missing');
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.senior', code: 'harness-unregistered' },
    { at: `${VERTICES}.senior-dev`, code: 'harness-unregistered' },
  ]);
});

// A Flow has no plan key: a planning Flow is a Flow run at Epic level, request slice 7's design (#298).
test('a Flow with a plan key, or without a positive actionCap, is an error', () => {
  const config = exampleSource.config();
  config.flows.default.actionCap = 0;
  exampleSource.putAt(config.flows, ['light'], {
    plan: null,
    actionCap: 20,
    ticket: { entry: 'baseline', vertices: { baseline: { procedure: 'base-check' } } },
  });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'flows.light.plan', code: 'null-value' },
    { at: 'flows.default.actionCap', code: 'not-a-positive-integer' },
    { at: 'flows.light', code: 'unknown-key' },
    // baseline routes none of its Outcomes, reported beside the other errors (#436, D3 C).
    { at: 'flows.light.ticket.vertices.baseline', code: 'unrouted-outcome' },
  ]);
});

// In a configuration file null is never a value (#298): one pass reports each null at its path, and the checks of the
// key it sits on still run on it, so a null may be reported twice. A missing key is a different thing.
test('a null anywhere in the configuration is reported at its path, beside the rule the key breaks', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents, ['reviewer'], null);
  exampleSource.putAt(config.agents.implementer, ['harness'], null);
  exampleSource.putAt(config.flows.default.ticket, ['entry'], null);
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['procedure'], null);
  exampleSource.putAt(config.flows.default.ticket.vertices.green, ['model'], null);
  exampleSource.putAt(config.procedures['tests-fail'].actions, ['1'], null);
  const { errors } = exampleSource.check(config);
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
  const config = exampleSource.config();
  exampleSource.putAt(config.agents, ['spare'], { persona: 'implementer.md', harness: null });
  exampleSource.putAt(config.flows.default.ticket.vertices.green, ['model'], null);
  exampleSource.putAt(config.flows, ['light'], {
    actionCap: 1,
    ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } },
  });
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.spare.harness', code: 'null-value' },
    { at: 'flows.default.ticket.vertices.green.model', code: 'null-value' },
    { at: 'agents.spare', code: 'invalid-name' },
    { at: 'flows.light.ticket.vertices.gate', code: 'unrouted-outcome' },
  ]);
});

// A harness is a name the registry is asked for; a value of another shape is never looked up.
test('a harness that is not a name is an invalid name, not an unregistered harness', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.implementer, ['harness'], 7);
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [{ at: 'agents.implementer', code: 'invalid-name' }]);
  assert.equal(errors[0].message, "agent implementer's harness 7 must not be empty or only whitespace");
});

test('a present null id is a wrong value, so a Check still prints it', () => {
  const config = exampleSource.config();
  const check = procedureActions.actionById(config.procedures['base-check'], 'test');
  exampleSource.putAt(check, ['id'], null);
  exampleSource.putAt(check, ['command']);
  assert.deepEqual(
    exampleSource.check(config).errors.map((problem) => problem.message),
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
    { flows, errors: exampleSource.firedRules(errors), warnings },
    { flows: {}, errors: [{ at: '', code: 'not-an-object' }], warnings: [] },
  );
});

// A pass is the agent Action and the Checks after it (T4, R1a): every Check runs before any effect, so a commit or
// pr-ready counts only Checks that ran (Q3a), and no effect runs for a Visit that then stops or fails (Q3).

// The example's implement Actions by id, so each order case lists every Action of the order it builds.
const implementActions = (config: exampleSource.Source) =>
  ['green', 'test', 'commit', 'push', 'pr'].map((id) => procedureActions.actionById(config.procedures.implement, id));

test('a Check after an effect Action is an error', () => {
  const config = exampleSource.config();
  const [green, check, commit, push, pr] = implementActions(config);
  config.procedures.implement.actions = [green, commit, check, push, pr];
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    {
      at: 'procedures.implement.actions[2]',
      code: 'check-after-effect',
    },
  ]);
});

test('an agent Action after a Check is an error', () => {
  const config = exampleSource.config();
  const [green, check, commit, push, pr] = implementActions(config);
  config.procedures.implement.actions = [check, green, commit, push, pr];
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    {
      at: 'procedures.implement.actions[1]',
      code: 'agent-action-not-first',
    },
  ]);
});

test('a comment between the agent Action and its Checks is an error', () => {
  const config = exampleSource.config();
  const [green, check, commit, push, pr] = implementActions(config);
  const note = { id: 'note', do: 'comment', target: 'ticket', body: 'note.md' };
  exampleSource.putAt(config.procedures.implement, ['actions'], [green, note, check, commit, push, pr]);
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    {
      at: 'procedures.implement.actions[2]',
      code: 'check-after-effect',
    },
  ]);
});

test('a commit in a Procedure with no agent Action is an error', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures['base-check'].actions, ['1'], { id: 'commit', do: 'commit', type: 'chore' });
  const { errors } = exampleSource.check(config);
  assert.deepEqual(exampleSource.firedRules(errors), [
    {
      at: 'procedures.base-check.actions[1]',
      code: 'needs-agent-action',
    },
  ]);
});

test("a Vertex's maxVisits is an unknown key: its Bound is max, as on an edge", () => {
  const config = exampleSource.config();
  const vertex = config.flows.default.ticket.vertices['senior-dev'];
  exampleSource.putAt(vertex, ['maxVisits'], vertex.max);
  exampleSource.putAt(vertex, ['max']);
  exampleSource.putAt(vertex, ['exhausted']);
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: `${VERTICES}.senior-dev`, code: 'unknown-key' },
  ]);
});

// The configuration keys #229 renamed: a Source still written with an old key fails admission as any unknown key does.
const oldKeyOf = <Action extends object>(action: Action, oldKey: string, newKey: string) => {
  assert.ok(referencePaths.isRecord(action));
  exampleSource.putAt(action, [oldKey], action[newKey] ?? action[oldKey]);
  exampleSource.putAt(action, [newKey]);
};
const RENAMED_KEYS: [string, (config: exampleSource.Source) => unknown, string][] = [
  [
    'all-of',
    (config) => oldKeyOf(procedureActions.actionById(config.procedures.review, 'review-pass'), 'all-of', 'allOf'),
    'procedures.review.actions[1]',
  ],
  [
    'names',
    (config) =>
      oldKeyOf(procedureActions.actionById(config.procedures['tests-fail'], 'red-check'), 'names', 'testNames'),
    'procedures.tests-fail.actions[1]',
  ],
  ['claims', (config) => oldKeyOf(config.procedures.review, 'claims', 'claimTokens'), 'procedures.review'],
  [
    'resolution',
    (config) => exampleSource.putAt(config.agents.implementer, ['resolution'], { transient: 1 }),
    'agents.implementer',
  ],
  [
    'resolution',
    (config) => exampleSource.putAt(config.flows.default.ticket.vertices.red, ['resolution'], { transient: 1 }),
    `${VERTICES}.red`,
  ],
];
for (const [oldKey, write, location] of RENAMED_KEYS) {
  test(`a Source written with a renamed key fails admission as an unknown key: ${oldKey} at ${location}`, () => {
    const config = exampleSource.config();
    write(config);
    const unknown = exampleSource.check(config).errors.filter((problem) => problem.code === 'unknown-key');
    assert.deepEqual(exampleSource.firedRules(unknown), [{ at: location, code: 'unknown-key' }]);
  });
}

test('an Agent with a key no Agent declares is an error at agents.<name>', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.reviewer, ['modle'], 'opus');
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'agents.reviewer', code: 'unknown-key' },
  ]);
});

test('an Agent and a Vertex may declare a resolutionPolicy', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.agents.implementer, ['resolutionPolicy'], { transient: 1 });
  exampleSource.putAt(config.flows.default.ticket.vertices.red, ['resolutionPolicy'], { transient: 1 });
  assert.deepEqual(exampleSource.check(config).errors, []);
});

// The request's key tables a Source's author reads list exactly the keys the validator accepts (#229).
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
  const config = exampleSource.config();
  // A Procedure with no agent Action, whose implicit Claim ok requires every Check.
  exampleSource.putAt(config.procedures['base-check'].actions[0], ['id'], JSON.parse('{"toString": 1}'));
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.base-check.actions[0]', code: 'invalid-name' },
  ]);
});

test('an otherwise that is an object is an error, never a throw', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures.review, ['otherwise'], JSON.parse('{"toString": 1}'));
  assert.deepEqual(exampleSource.firedRules(exampleSource.check(config).errors), [
    { at: 'procedures.review.otherwise', code: 'invalid-otherwise' },
  ]);
});

// Each slot the configuration names something in, given a value that is not a string (an object whose toString is not
// callable, so a property key or a route lookup made of it would throw): the validator reports it at its location and
// keeps it out of every collection and route (#174).
const REJECTED_NAME = '{"toString": 1}';
const REJECTED_SLOTS: [string, (config: exampleSource.Source, value: unknown) => void, string][] = [
  [
    'an Action id',
    (config, value) => exampleSource.putAt(config.procedures['base-check'].actions[0], ['id'], value),
    'procedures.base-check',
  ],
  [
    'an otherwise',
    (config, value) => exampleSource.putAt(config.procedures.review, ['otherwise'], value),
    'procedures.review',
  ],
  [
    'a table outcome',
    (config, value) => exampleSource.putAt(config.procedures.review.passed[0], ['outcome'], value),
    'procedures.review',
  ],
  [
    'a Decision',
    (config, value) => {
      exampleSource.putAt(config.procedures, ['approval'], {
        actions: [{ id: 'ask', do: 'await-approval', decisions: [value] }],
      });
      exampleSource.putAt(config.flows.default.ticket.vertices, ['approve'], { procedure: 'approval', route: {} });
    },
    'procedures.approval',
  ],
];
for (const [what, mutate, location] of REJECTED_SLOTS) {
  test(`${what} that is not a string is reported at its location and never thrown on`, () => {
    const config = exampleSource.config();
    mutate(config, JSON.parse(REJECTED_NAME));
    const { errors } = exampleSource.check(config);
    assert.ok(
      errors.some((problem) => problem.at.startsWith(location)),
      `an error at ${location}, got ${JSON.stringify(exampleSource.firedRules(errors))}`,
    );
  });
}
