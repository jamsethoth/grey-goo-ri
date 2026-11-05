import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as validate from '../../lib/validate/index.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as procedureActions from '../support/procedure-actions.ts';
import * as requestTables from '../support/request-tables.ts';

// Every expected error and warning is a Problem, whose persisted key is `at` (lib/validate/report.ts).
/* eslint-disable id-denylist -- a Problem's key is at */

const VERTICES = 'flows.default.ticket.vertices';

test('the example Flow resolves with no errors', () => {
  const { errors } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(errors, []);
});

test("the example Flow warns only of the review table's two intended overlaps", () => {
  const { warnings } = exampleLayer.check(exampleLayer.config());
  assert.deepEqual(
    warnings.map((warning) => warning.at),
    ['procedures.review.passed', 'procedures.review.passed'],
  );
  assert.match(
    warnings[0].message,
    /^rule table review\.passed: row 2 \(check\.repeat = failed\) is partly taken by row 1 /,
  );
  assert.match(
    warnings[1].message,
    /^rule table review\.passed: row 3 \(response\.needsTest = true\) is partly taken by row 1 .*, row 2 /,
  );
});

test("the Resolved Flow carries each Vertex's Agent, Procedure, access, tests and Outcomes", () => {
  const { flows } = exampleLayer.check(exampleLayer.config());
  assert.equal(flows.default.actionCap, 180);
  assert.equal(flows.default.plan, null);
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
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.base-check.claimTokens',
      message:
        'a Procedure with no agent Action declares no claimTokens: its implicit Claim ok requires every Check it ' +
        'declares',
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
  assert.deepEqual(errors, [
    {
      at: `${VERTICES}.green.access`,
      message: 'access "read-write" is not a Permission Intent: read-only or workspace-write',
    },
  ]);
});

test('a Claim token named failed or harness-timeout is an error', () => {
  const config = exampleLayer.config();
  config.procedures['tests-fail'].claimTokens.failed = { stop: true };
  config.procedures['tests-fail'].claimTokens['harness-timeout'] = { stop: true };
  const files = exampleLayer.schemas();
  files['red.schema.json'].properties.claim.enum = ['ok', 'blocked', 'failed', 'harness-timeout'];
  assert.deepEqual(exampleLayer.check(config, files).errors, [
    {
      at: 'procedures.tests-fail.claimTokens.failed',
      message: 'Claim token "failed" is reserved for the engine: failed, an end name or harness-*',
    },
    {
      at: 'procedures.tests-fail.claimTokens.harness-timeout',
      message: 'Claim token "harness-timeout" is reserved for the engine: failed, an end name or harness-*',
    },
  ]);
});

test('a table outcome or otherwise named after an end is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.otherwise = 'needs-replan';
  config.procedures['tests-fail'].stopped[0].outcome = 'needs-human';
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.tests-fail.stopped[0]',
      message: 'outcome "needs-human" is reserved for the engine: failed, an end name or harness-*',
    },
    {
      at: 'procedures.review.otherwise',
      message: 'otherwise "needs-replan" is reserved for the engine: failed, an end name or harness-*',
    },
  ]);
});

const INHERITED = 'is reserved: every object inherits a property of that name from Object.prototype';

test('a Vertex named __proto__ is an error, never dropped', () => {
  const config = exampleLayer.config();
  const { vertices } = config.flows.default.ticket;
  // JSON.parse and spread make __proto__ an own key, as a Layer's JSON does; assignment would set the prototype.
  config.flows.default.ticket.vertices = { ...vertices, ...JSON.parse('{"__proto__": {"procedure": "base-check"}}') };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.__proto__`, message: `Vertex id "__proto__" ${INHERITED}` },
  ]);
});

test('a name of an Object.prototype property is reserved wherever the configuration names something', () => {
  const config = exampleLayer.config();
  config.agents.valueOf = { persona: 'implementer.md', harness: 'fake' };
  config.procedures['tests-fail'].claimTokens.isPrototypeOf = { stop: true };
  config.procedures['tests-fail'].stopped[0].outcome = 'toString';
  config.procedures.review.otherwise = 'toLocaleString';
  config.procedures.gate = {
    actions: [{ id: 'constructor', do: 'check', kind: 'command', command: 'test' }],
    passed: [{ when: { 'check.constructor': 'passed' }, outcome: 'ok' }],
  };
  config.procedures.hasOwnProperty = config.procedures['base-check'];
  config.flows.propertyIsEnumerable = {
    plan: null,
    actionCap: 1,
    ticket: {
      entry: 'valueOf',
      routes: { toString: { end: 'needs-human' } },
      vertices: {
        valueOf: {
          procedure: 'gate',
          inputs: { constructor: { from: 'valueOf.rescue', optional: true } },
          route: { __lookupGetter__: { end: 'needs-human' } },
        },
      },
    },
  };
  const ticketLocation = 'flows.propertyIsEnumerable.ticket';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.valueOf', message: `Agent "valueOf" ${INHERITED}` },
    { at: 'procedures.tests-fail.claimTokens.isPrototypeOf', message: `Claim token "isPrototypeOf" ${INHERITED}` },
    { at: 'procedures.tests-fail.stopped[0]', message: `outcome "toString" ${INHERITED}` },
    { at: 'procedures.review.otherwise', message: `otherwise "toLocaleString" ${INHERITED}` },
    { at: 'procedures.gate.actions[0]', message: `Action id "constructor" ${INHERITED}` },
    { at: 'procedures.hasOwnProperty', message: `Procedure "hasOwnProperty" ${INHERITED}` },
    { at: 'flows.propertyIsEnumerable', message: `Flow "propertyIsEnumerable" ${INHERITED}` },
    { at: `${ticketLocation}.routes.toString`, message: `route key "toString" ${INHERITED}` },
    { at: `${ticketLocation}.vertices.valueOf`, message: `Vertex id "valueOf" ${INHERITED}` },
    { at: `${ticketLocation}.vertices.valueOf.inputs.constructor`, message: `input "constructor" ${INHERITED}` },
    {
      at: `${ticketLocation}.vertices.valueOf.route.__lookupGetter__`,
      message: `route key "__lookupGetter__" ${INHERITED}`,
    },
  ]);
});

const CARRIED = 'must be non-empty with no ":", ".", "/", "--" or whitespace';
const BLANK = 'must not be empty or only whitespace';

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
    assert.deepEqual(exampleLayer.check(config).errors, [
      { at: 'procedures.base-check.actions[0]', message: `Action id ${JSON.stringify(id)} ${CARRIED}` },
    ]);
  });
}

// A second Flow of one Vertex, whose id the case chooses, running the example's base-check.
const oneVertexFlow = (id: string) => ({
  plan: null,
  actionCap: 1,
  ticket: { entry: id, vertices: { [id]: { procedure: 'base-check', route: { ok: { end: 'needs-human' } } } } },
});

for (const [id, form] of CARRIED_BREAKS) {
  test(`a Vertex id ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.flows.names = oneVertexFlow(id);
    assert.deepEqual(exampleLayer.check(config).errors, [
      { at: `flows.names.ticket.vertices.${id}`, message: `Vertex id ${JSON.stringify(id)} ${CARRIED}` },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`a Procedure name ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.procedures[name] = config.procedures['base-check'];
    config.flows.default.ticket.vertices.baseline.procedure = name;
    assert.deepEqual(exampleLayer.check(config).errors, [
      { at: `procedures.${name}`, message: `Procedure ${JSON.stringify(name)} ${CARRIED}` },
    ]);
  });
}

for (const [name, form] of CARRIED_BREAKS) {
  test(`an input name ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.flows.default.ticket.vertices['implementer-fix'].inputs[name] = { from: 'red.commit.files' };
    const inputLocation = `flows.default.ticket.vertices.implementer-fix.inputs.${name}`;
    assert.deepEqual(
      exampleLayer.check(config).errors.filter((problem) => problem.at === inputLocation),
      [{ at: inputLocation, message: `input ${JSON.stringify(name)} ${CARRIED}` }],
    );
  });
}

for (const [name, form] of BLANK_BREAKS) {
  test(`an Agent or Flow name that is ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.agents[name] = config.agents.senior;
    config.flows[name] = oneVertexFlow('only');
    assert.deepEqual(exampleLayer.check(config).errors, [
      { at: `agents.${name}`, message: `Agent ${JSON.stringify(name)} ${BLANK}` },
      { at: `flows.${name}`, message: `Flow ${JSON.stringify(name)} ${BLANK}` },
    ]);
  });

  test(`a Claim token that is ${form} is an error at its location`, () => {
    const config = exampleLayer.config();
    config.procedures['tests-fail'].claimTokens[name] = { stop: true };
    const tokenLocation = `procedures.tests-fail.claimTokens.${name}`;
    assert.deepEqual(
      exampleLayer.check(config).errors.filter((problem) => problem.at === tokenLocation),
      [{ at: tokenLocation, message: `Claim token ${JSON.stringify(name)} ${BLANK}` }],
    );
  });
}

test("a configuration without a Flow names the request's key tables, not gg init", () => {
  const config = exampleLayer.config();
  delete config.flows;
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'flows',
      message:
        'no Flow is declared; docs/requests/node-harness-dag.md tables the keys of a Flow (3.3) and of a Procedure ' +
        '(3.4)',
    },
  ]);
});

test('a repeated Action id is an error', () => {
  const config = exampleLayer.config();
  const pr = procedureActions.actionById(config.procedures.publish, 'pr');
  pr.id = 'test';
  pr.do = 'push';
  delete pr.body;
  delete pr.with;
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'procedures.publish.actions[1]', message: 'Action id "test" is repeated' },
  ]);
});

test('a second agent Action in a Procedure is an error', () => {
  const config = exampleLayer.config();
  config.procedures.review.actions.push({ id: 'again', do: 'agent', brief: 'review.md', schema: 'review.schema.json' });
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'procedures.review.actions[5]', message: 'a Procedure has at most one agent Action' },
  ]);
});

test('an unknown key is an error naming it', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.rout = {};
  procedureActions.actionById(config.procedures.publish, 'pr-ready').draft = true;
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'procedures.publish.actions[2]', message: 'unknown key "draft"' },
    { at: `${VERTICES}.red`, message: 'unknown key "rout"' },
  ]);
});

test('an unknown Action kind or Check kind is an error', () => {
  const config = exampleLayer.config();
  procedureActions.actionById(config.procedures.publish, 'pr-ready').do = 'merge';
  procedureActions.actionById(config.procedures['base-check'], 'test').kind = 'changes';
  assert.deepEqual(exampleLayer.check(config).errors, [
    {
      at: 'procedures.base-check.actions[0]',
      message: 'Check kind "changes" is not one of command, tests-fail, response, repeat',
    },
    {
      at: 'procedures.publish.actions[2]',
      message: 'do "merge" is not one of agent, check, commit, push, pr-upsert, pr-ready, comment, await-approval',
    },
  ]);
});

test('a token requiring an Action that is not a Check is an error', () => {
  const config = exampleLayer.config();
  config.procedures.implement.claimTokens.ok.requires = ['commit'];
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'procedures.implement.claimTokens.ok', message: 'requires "commit", which is not a Check of this Procedure' },
  ]);
});

test('a Vertex naming an undeclared Procedure or Agent is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  config.flows.default.ticket.vertices.green.use = 'coder';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.red`, message: 'procedure "red" is not declared' },
    { at: `${VERTICES}.green`, message: 'uses agent "coder", which is not declared' },
  ]);
});

test('an agent Procedure on a Vertex with no Agent, or an Agent on an agentless one, is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.ticket.vertices.red.use;
  config.flows.default.ticket.vertices.publish.use = 'implementer';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.red`, message: 'procedure tests-fail has an agent Action, so the Vertex needs an Agent' },
    { at: `${VERTICES}.publish`, message: 'procedure publish has no agent Action, so the Vertex takes no Agent' },
  ]);
});

test('an Agent with no harness or an unregistered one is an error', () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.harness;
  config.agents.senior.harness = 'other';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.reviewer', message: 'agent reviewer names no harness; set one in a user or repository Layer' },
    { at: 'agents.senior', message: 'agent senior names harness "other", which is not registered' },
  ]);
});

test("an Agent with no harness is one error at the Agent, which a Vertex's own harness does not excuse", () => {
  const config = exampleLayer.config();
  delete config.agents.reviewer.harness;
  delete config.agents.senior.harness;
  config.flows.default.ticket.vertices.reviewer.harness = 'fake';
  delete config.flows.default.ticket.vertices.red.use;
  config.flows.default.ticket.vertices.red.model = 'opus';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.reviewer', message: 'agent reviewer names no harness; set one in a user or repository Layer' },
    { at: 'agents.senior', message: 'agent senior names no harness; set one in a user or repository Layer' },
    {
      at: `${VERTICES}.red`,
      message: 'the agent of Vertex red names no harness; set one in a user or repository Layer',
    },
  ]);
});

test('an empty Agent is one error at the Agent, not one per Vertex that uses it', () => {
  const config = exampleLayer.config();
  config.agents.senior = {};
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.senior', message: 'agent senior names no harness; set one in a user or repository Layer' },
  ]);
});

test('an unused Agent naming an unregistered harness is an error', () => {
  const config = exampleLayer.config();
  config.agents.spare = { persona: 'implementer.md', harness: 'other' };
  config.agents.blank = 'spare.md';
  config.agents.bare = { persona: 'implementer.md' };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.spare', message: 'agent spare names harness "other", which is not registered' },
    { at: 'agents.blank', message: 'an Agent must be an object' },
    { at: 'agents.bare', message: 'agent bare names no harness; set one in a user or repository Layer' },
  ]);
});

test('an Agent no Vertex uses is a warning', () => {
  const config = exampleLayer.config();
  config.agents.spare = { persona: 'implementer.md', harness: 'fake' };
  const { errors, warnings } = exampleLayer.check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    warnings.filter((warning) => warning.at.startsWith('agents.')),
    [{ at: 'agents.spare', message: 'agent spare is used by no Vertex' }],
  );
});

test("an Agent's error is reported once however many Vertices use it", () => {
  const config = exampleLayer.config();
  config.agents.senior.harness = 'other';
  config.flows.default.ticket.vertices['senior-dev'].harness = 'missing';
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'agents.senior', message: 'agent senior names harness "other", which is not registered' },
    { at: `${VERTICES}.senior-dev`, message: 'agent senior names harness "missing", which is not registered' },
  ]);
});

test('a Vertex named after an end, cleanup or done is an error', () => {
  const config = exampleLayer.config();
  config.flows.default.ticket.vertices.cleanup = { procedure: 'base-check' };
  config.flows.default.ticket.vertices.done = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-human'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['ready-for-qa'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-replan'] = { procedure: 'base-check' };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.cleanup`, message: 'Vertex id "cleanup" is reserved: an end name, cleanup or done' },
    { at: `${VERTICES}.done`, message: 'Vertex id "done" is reserved: an end name, cleanup or done' },
    { at: `${VERTICES}.needs-human`, message: 'Vertex id "needs-human" is reserved: an end name, cleanup or done' },
    { at: `${VERTICES}.ready-for-qa`, message: 'Vertex id "ready-for-qa" is reserved: an end name, cleanup or done' },
    { at: `${VERTICES}.needs-replan`, message: 'Vertex id "needs-replan" is reserved: an end name, cleanup or done' },
  ]);
});

test('a Flow without plan: null or a positive actionCap is an error', () => {
  const config = exampleLayer.config();
  delete config.flows.default.plan;
  config.flows.default.actionCap = 0;
  config.flows.light = {
    plan: 'epic',
    actionCap: 20,
    ticket: { entry: 'baseline', vertices: { baseline: { procedure: 'base-check' } } },
  };
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: 'flows.default', message: 'plan is required: null when the Flow has no Epic-level planning' },
    { at: 'flows.default.actionCap', message: 'actionCap must be a positive integer' },
    { at: 'flows.light.plan', message: 'plan must be null until Epic planning is built' },
  ]);
});

test('a configuration that is not an object is one error, not a throw', () => {
  assert.deepEqual(validate.validate(null, { harnesses: {}, readSchema: () => ({}) }), {
    flows: {},
    errors: [{ at: '(root)', message: 'the configuration must be an object' }],
    warnings: [],
  });
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
  assert.deepEqual(errors, [
    {
      at: 'procedures.implement.actions[2]',
      message:
        'Check test comes after commit Action commit; every Check comes before any effect, so no effect runs before ' +
        'its pass is decided',
    },
  ]);
});

test('an agent Action after a Check is an error', () => {
  const config = exampleLayer.config();
  const [green, check, commit, push, pr] = implementActions(config);
  config.procedures.implement.actions = [check, green, commit, push, pr];
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(errors, [
    {
      at: 'procedures.implement.actions[1]',
      message: 'the agent Action comes first, so a recovery pass runs every Check again after it',
    },
  ]);
});

test('a comment between the agent Action and its Checks is an error', () => {
  const config = exampleLayer.config();
  const [green, check, commit, push, pr] = implementActions(config);
  const note = { id: 'note', do: 'comment', target: 'ticket', body: 'note.md' };
  config.procedures.implement.actions = [green, note, check, commit, push, pr];
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(errors, [
    {
      at: 'procedures.implement.actions[2]',
      message:
        'Check test comes after comment Action note; every Check comes before any effect, so no effect runs before ' +
        'its pass is decided',
    },
  ]);
});

test('a commit in a Procedure with no agent Action is an error', () => {
  const config = exampleLayer.config();
  config.procedures['base-check'].actions.push({ id: 'commit', do: 'commit', type: 'chore' });
  const { errors } = exampleLayer.check(config);
  assert.deepEqual(errors, [
    {
      at: 'procedures.base-check.actions[1]',
      message: "a commit carries the agent Action's summary, which this Procedure lacks",
    },
  ]);
});

test("a Vertex's maxVisits is an unknown key: its Bound is max, as on an edge", () => {
  const config = exampleLayer.config();
  const vertex = config.flows.default.ticket.vertices['senior-dev'];
  vertex.maxVisits = vertex.max;
  delete vertex.max;
  delete vertex.exhausted;
  assert.deepEqual(exampleLayer.check(config).errors, [
    { at: `${VERTICES}.senior-dev`, message: 'unknown key "maxVisits"' },
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
    const unknown = exampleLayer.check(config).errors.filter((problem) => problem.message.startsWith('unknown key'));
    assert.deepEqual(unknown, [{ at: location, message: `unknown key "${oldKey}"` }]);
  });
}

test('an Agent with a key no Agent declares is an error at agents.<name>', () => {
  const config = exampleLayer.config();
  config.agents.reviewer.modle = 'opus';
  assert.deepEqual(exampleLayer.check(config).errors, [{ at: 'agents.reviewer', message: 'unknown key "modle"' }]);
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
