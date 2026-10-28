import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/example/${name}`, import.meta.url), 'utf8'));

// The example Flow as `gg init` writes it, plus the per-person harness a user Layer adds (P2).
function example() {
  const config = fixture('gg.json');
  for (const agent of Object.values(config.agents)) agent.harness = 'fake';
  return config;
}
const schemas = () => ({
  'red.schema.json': fixture('red.schema.json'),
  'implement.schema.json': fixture('implement.schema.json'),
  'review.schema.json': fixture('review.schema.json'),
});

async function check(config, files = schemas()) {
  const validate = await import('../../lib/validate.mjs');
  return validate.validate(config, {
    harnesses: { fake: {} },
    readSchema: (name) => {
      if (!Object.hasOwn(files, name)) throw new Error('no such file');
      return files[name];
    },
  });
}

const V = 'flows.default.ticket.vertices';

test('the example Flow resolves with no errors', async () => {
  const { errors } = await check(example());
  assert.deepEqual(errors, []);
});

test('the example Flow warns only of the review table\'s two intended overlaps', async () => {
  const { warnings } = await check(example());
  assert.deepEqual(warnings.map((w) => w.at), ['procedures.review.passed', 'procedures.review.passed']);
  assert.match(warnings[0].message, /^rule table review\.passed: row 2 \(check\.repeat = failed\) is partly taken by row 1 /);
  assert.match(warnings[1].message, /^rule table review\.passed: row 3 \(response\.needsTest = true\) is partly taken by row 1 .*, row 2 /);
});

test('the Resolved Flow carries each Vertex\'s Agent, Procedure, access, tests and Outcomes', async () => {
  const { flows } = await check(example());
  assert.equal(flows.default.actionCap, 180);
  assert.equal(flows.default.plan, null);
  assert.equal(flows.default.ticket.entry, 'baseline');
  const red = flows.default.ticket.vertices.red;
  assert.deepEqual(red.agent, { persona: 'implementer.md', access: 'workspace-write', harness: 'fake', model: null, effort: null });
  assert.equal(red.procedure, 'tests-fail');
  assert.equal(red.access, 'workspace-write');
  assert.equal(red.tests, 'write');
  assert.deepEqual(red.outcomes, ['ok', 'failed', 'misscoped', 'no-test', 'blocked', 'harness-timeout', 'harness-transient', 'harness-unparsed']);
  assert.deepEqual(flows.default.ticket.vertices.reviewer.outcomes,
    ['ok', 'repeat', 'retest', 'changes', 'misscoped', 'blocked', 'harness-timeout', 'harness-transient', 'harness-unparsed']);
  assert.deepEqual(flows.default.ticket.vertices.publish.outcomes, ['ok', 'failed']);
});

test('a Procedure with no agent Action has the implicit Claim ok requiring every Check', async () => {
  const { flows } = await check(example());
  assert.deepEqual(flows.default.procedures.publish.claims, { ok: { requires: ['test'] } });
  assert.equal(flows.default.ticket.vertices.publish.agent, null);
});

test('a Procedure with no agent Action that declares claims is an error', async () => {
  const config = example();
  config.procedures['base-check'].claims = { ok: { requires: ['test'] } };
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.base-check.claims',
    message: 'a Procedure with no agent Action declares no claims: its implicit Claim ok requires every Check it declares',
  }]);
});

test('access: read-only on the Procedure caps the Agent', async () => {
  const config = example();
  config.agents.reviewer.access = 'workspace-write';
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.vertices.reviewer.agent.access, 'workspace-write');
  assert.equal(flows.default.ticket.vertices.reviewer.access, 'read-only');
});

test('a Claim token named failed or harness-timeout is an error', async () => {
  const config = example();
  config.procedures['tests-fail'].claims.failed = { stop: true };
  config.procedures['tests-fail'].claims['harness-timeout'] = { stop: true };
  const files = schemas();
  files['red.schema.json'].properties.claim.enum = ['ok', 'blocked', 'failed', 'harness-timeout'];
  assert.deepEqual((await check(config, files)).errors, [
    { at: 'procedures.tests-fail.claims.failed', message: 'Claim token "failed" is reserved for the engine: failed, an end name or harness-*' },
    { at: 'procedures.tests-fail.claims.harness-timeout', message: 'Claim token "harness-timeout" is reserved for the engine: failed, an end name or harness-*' },
  ]);
});

test('a table outcome or otherwise named after an end is an error', async () => {
  const config = example();
  config.procedures.review.otherwise = 'needs-replan';
  config.procedures['tests-fail'].stopped[0].outcome = 'needs-human';
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.tests-fail.stopped[0]', message: 'outcome "needs-human" is reserved for the engine: failed, an end name or harness-*' },
    { at: 'procedures.review.otherwise', message: 'otherwise "needs-replan" is reserved for the engine: failed, an end name or harness-*' },
  ]);
});

test('a Claim enum that differs from the declared tokens is an error', async () => {
  const config = example();
  config.procedures['tests-fail'].claims.stuck = { stop: true };
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.tests-fail.claims',
    message: 'red.schema.json: claim: enum "ok" | "blocked" does not equal the declared tokens "ok" | "blocked" | "stuck"',
  }]);
});

test('a schema outside the strict subset is an error naming the file', async () => {
  const files = schemas();
  files['review.schema.json'].properties.summary = { type: 'string', minLength: 1 };
  assert.deepEqual((await check(example(), files)).errors, [{
    at: 'procedures.review.actions[0]',
    message: 'review.schema.json: (root).summary: keyword "minLength" is outside the strict subset',
  }]);
});

test('a schema that cannot be read is an error naming the file', async () => {
  const files = schemas();
  delete files['review.schema.json'];
  assert.deepEqual((await check(example(), files)).errors, [{
    at: 'procedures.review.actions[0]',
    message: 'schema review.schema.json cannot be read: no such file',
  }]);
});

test('an undeclared command is an error naming the Check', async () => {
  const config = example();
  config.procedures.implement.actions[1].command = 'lint';
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.implement.actions[1]',
    message: 'Check test names command "lint", which the repository Layer does not declare',
  }]);
});

test('an Action id with a colon is an error', async () => {
  const config = example();
  config.procedures['base-check'].actions[0].id = 'te:st';
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.base-check.actions[0]',
    message: 'Action id "te:st" must be non-empty with no ":", "." or whitespace',
  }]);
});

test('an Action id with whitespace is an error', async () => {
  const config = example();
  config.procedures['base-check'].actions[0].id = 'te st';
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.base-check.actions[0]',
    message: 'Action id "te st" must be non-empty with no ":", "." or whitespace',
  }]);
});

test('a configuration with no Flow is an error naming gg init', async () => {
  const config = example();
  delete config.flows;
  assert.deepEqual((await check(config)).errors, [{ at: 'flows', message: 'no Flow is declared; gg init writes an example' }]);
});

test('a repeated Action id is an error', async () => {
  const config = example();
  config.procedures.publish.actions[1].id = 'test';
  config.procedures.publish.actions[1].do = 'push';
  delete config.procedures.publish.actions[1].body;
  delete config.procedures.publish.actions[1].with;
  assert.deepEqual((await check(config)).errors, [{ at: 'procedures.publish.actions[1]', message: 'Action id "test" is repeated' }]);
});

test('a second agent Action in a Procedure is an error', async () => {
  const config = example();
  config.procedures.review.actions.push({ id: 'again', do: 'agent', brief: 'review.md', schema: 'review.schema.json' });
  assert.deepEqual((await check(config)).errors, [{ at: 'procedures.review.actions[5]', message: 'a Procedure has at most one agent Action' }]);
});

test('an unknown key is an error naming it', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.rout = {};
  config.procedures.publish.actions[2].draft = true;
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.publish.actions[2]', message: 'unknown key "draft"' },
    { at: `${V}.red`, message: 'unknown key "rout"' },
  ]);
});

test('an unknown Action kind or Check kind is an error', async () => {
  const config = example();
  config.procedures.publish.actions[2].do = 'merge';
  config.procedures['base-check'].actions[0].kind = 'changes';
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.base-check.actions[0]', message: 'Check kind "changes" is not one of command, tests-fail, response, repeat' },
    { at: 'procedures.publish.actions[2]', message: 'do "merge" is not one of agent, check, commit, push, pr-upsert, pr-ready, comment, await-approval' },
  ]);
});

test('a token requiring an Action that is not a Check is an error', async () => {
  const config = example();
  config.procedures.implement.claims.ok.requires = ['commit'];
  assert.deepEqual((await check(config)).errors, [{ at: 'procedures.implement.claims.ok', message: 'requires "commit", which is not a Check of this Procedure' }]);
});

test('a Vertex naming an undeclared Procedure or Agent is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  config.flows.default.ticket.vertices.green.use = 'coder';
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.red`, message: 'procedure "red" is not declared' },
    { at: `${V}.green`, message: 'uses agent "coder", which is not declared' },
  ]);
});

test('an agent Procedure on a Vertex with no Agent, or an Agent on an agentless one, is an error', async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.red.use;
  config.flows.default.ticket.vertices.publish.use = 'implementer';
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.red`, message: 'procedure tests-fail has an agent Action, so the Vertex needs an Agent' },
    { at: `${V}.publish`, message: 'procedure publish has no agent Action, so the Vertex takes no Agent' },
  ]);
});

test('an Agent with no harness or an unregistered one is an error', async () => {
  const config = example();
  delete config.agents.reviewer.harness;
  config.agents.senior.harness = 'other';
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.senior-green`, message: 'agent senior names harness "other", which is not registered' },
    { at: `${V}.reviewer`, message: 'agent reviewer names no harness; set one in a user or repository Layer' },
    { at: `${V}.senior-red`, message: 'agent senior names harness "other", which is not registered' },
    { at: `${V}.senior-dev`, message: 'agent senior names harness "other", which is not registered' },
  ]);
});

test('a route or entry naming no Vertex is an error', async () => {
  const config = example();
  config.flows.default.ticket.entry = 'start';
  config.flows.default.ticket.vertices.green.route.ok = 'review';
  config.flows.default.ticket.vertices.reviewer.route.retest.exhausted = 'senior';
  assert.deepEqual((await check(config)).errors, [
    { at: 'flows.default.ticket.entry', message: '"start" is not a Vertex' },
    { at: `${V}.green.route.ok`, message: '"review" is not a Vertex' },
    { at: `${V}.reviewer.route.retest`, message: '"senior" is not a Vertex' },
  ]);
});

test('an end naming done or no end is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.publish.route.ok = { end: 'done' };
  config.flows.default.ticket.routes['*'] = { end: 'merged' };
  assert.deepEqual((await check(config)).errors, [
    { at: 'flows.default.ticket.routes.*', message: 'end "merged" is not one of ready-for-qa, needs-human, needs-replan' },
    { at: `${V}.publish.route.ok`, message: 'end "done" is the human-only end, which no route may name' },
  ]);
});

test('a Vertex named after an end, cleanup or done is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.cleanup = { procedure: 'base-check' };
  config.flows.default.ticket.vertices.done = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-human'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['ready-for-qa'] = { procedure: 'base-check' };
  config.flows.default.ticket.vertices['needs-replan'] = { procedure: 'base-check' };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.cleanup`, message: 'Vertex id "cleanup" is reserved: an end name, cleanup or done' },
    { at: `${V}.done`, message: 'Vertex id "done" is reserved: an end name, cleanup or done' },
    { at: `${V}.needs-human`, message: 'Vertex id "needs-human" is reserved: an end name, cleanup or done' },
    { at: `${V}.ready-for-qa`, message: 'Vertex id "ready-for-qa" is reserved: an end name, cleanup or done' },
    { at: `${V}.needs-replan`, message: 'Vertex id "needs-replan" is reserved: an end name, cleanup or done' },
  ]);
});

test('a Flow without plan: null or a positive actionCap is an error', async () => {
  const config = example();
  delete config.flows.default.plan;
  config.flows.default.actionCap = 0;
  config.flows.light = { plan: 'epic', actionCap: 20, ticket: { entry: 'baseline', vertices: { baseline: { procedure: 'base-check' } } } };
  assert.deepEqual((await check(config)).errors, [
    { at: 'flows.default', message: 'plan is required: null when the Flow has no Epic-level planning' },
    { at: 'flows.default.actionCap', message: 'actionCap must be a positive integer' },
    { at: 'flows.light.plan', message: 'plan must be null until Epic planning is built' },
  ]);
});

test('a reference to a field the schema lacks is an error', async () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].when = { 'response.cause': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'reviewer.review.response.issues';
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.tests-fail.stopped[0]', message: '"response.cause" is not defined' },
    { at: `${V}.red.inputs.findings`, message: '"reviewer.review.response.issues" is not defined' },
  ]);
});

test('a reference through an Action the Vertex\'s Procedure lacks is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.green.inputs.tests.from = ['red.commits.files', 'senior-red.commit.files'];
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.green.inputs.tests`, message: '"red.commits.files": "red.commits" is not defined' },
  ]);
});

test('a malformed reference path is the same error in a rule field and an input', async () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].when = { 'a..b': 'misscoped' };
  config.flows.default.ticket.vertices.red.inputs.findings.from = 'a..b';
  const { errors } = await check(config);
  assert.deepEqual(errors, [
    { at: 'procedures.tests-fail.stopped[0]', message: '"a..b" has an empty segment' },
    { at: `${V}.red.inputs.findings`, message: '"a..b" has an empty segment' },
  ]);
});

test('a list input with sources of different types is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.reviewer.inputs.report.from = ['green.green.response', 'red.red.response'];
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.reviewer.inputs.report`,
    message: 'sources "green.green.response" and "red.red.response" have different types',
  }]);
});

test('pick on a source that is not a list of objects is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.testFiles = { from: 'reviewer.review.response.summary', pick: 'file' };
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.implementer-fix.inputs.testFiles`,
    message: 'pick needs a list of objects; "reviewer.review.response.summary" is {"kind":"string"}',
  }]);
});

test('tests: named reading anything but a list of strings is an error', async () => {
  const config = example();
  config.procedures.fix.tests.named = 'inputs.findings';
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.implementer-fix (procedure fix).tests`, message: 'tests: named must read a list of strings; "inputs.findings" is {"kind":"list","of":{"kind":"object"}}' },
    { at: `${V}.senior-dev (procedure fix).tests`, message: 'tests: named must read a list of strings; "inputs.findings" is {"kind":"list","of":{"kind":"object"}}' },
  ]);
});

test('a Check parameter of the wrong type is an error', async () => {
  const config = example();
  config.procedures['tests-fail'].actions[1].names = 'response.summary';
  config.procedures.review.actions[2].fields = ['file', 'line'];
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.tests-fail.actions[1]', message: 'names must read a list of strings; "response.summary" is {"kind":"string"}' },
    { at: 'procedures.review.actions[2]', message: 'fields: "line" is not a field of the list\'s items' },
  ]);
});

test('a response Check condition outside the schema or its values is an error', async () => {
  const config = example();
  config.procedures.review.actions[1]['all-of'][0] = { field: 'dodMet', is: 'yes' };
  config.procedures.review.actions[1]['all-of'][2].where = { severity: ['blocker', 'critical'] };
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.review.actions[1]', message: 'all-of[0]: "dodMet" is a boolean, so is must be true or false' },
    { at: 'procedures.review.actions[1]', message: 'all-of[2]: where "severity": "critical" is not one of blocker | major | minor' },
  ]);
});

test('a rule on a free-text field is an error', async () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].when = { 'response.summary': 'x' };
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.tests-fail.stopped[0]',
    message: 'rule field "response.summary" is {"kind":"string"}; rules match only enum, boolean and integer fields',
  }]);
});

test('a malformed rule condition is an error', async () => {
  const config = example();
  config.procedures.review.passed[1].when = { 'check.repeat': { '!=': 'passed' } };
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.review.passed[1]',
    message: 'condition on "check.repeat" must be a string, boolean or integer, or an object of <, <=, >, >=, = with integers',
  }]);
});

test('a condition that does not fit its field is an error', async () => {
  const config = example();
  config.procedures.implement.passed = [{ when: { pass: 'two' }, outcome: 'ok' }];
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.implement.passed[0]',
    message: 'condition "two" on "pass" does not fit its field, which is {"kind":"integer","min":1,"max":2}',
  }]);
});

test('a row that never fires is an error from the rule table analysis', async () => {
  const config = example();
  config.procedures['tests-fail'].stopped.push({ when: { 'response.reason': 'misscoped' }, outcome: 'again' });
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.tests-fail.stopped',
    message: 'rule table tests-fail.stopped: row 3 (again) never fires: earlier rows match every input it matches',
  }]);
});

test('a passed row on a required Check failing is unreachable', async () => {
  const config = example();
  config.procedures.implement.passed = [{ when: { 'check.test': 'failed' }, outcome: 'odd' }];
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.implement.passed',
    message: 'rule table implement.passed: row 1 (odd) is unreachable: it matches no input',
  }]);
});

test('a failed table in a Procedure whose tokens require no Check is an error', async () => {
  const config = example();
  config.procedures.review.failed = [{ when: { 'check.repeat': 'failed' }, outcome: 'repeat' }];
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.review.failed',
    message: 'no Claim token requires a Check, so the failed table never applies',
  }]);
});

test('a rule on an input is typed at each Vertex using the Procedure', async () => {
  const config = example();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.needsTest = { from: 'reviewer.review.response.needsTest', optional: true };
  config.procedures.fix.passed = [{ when: { 'inputs.needsTest': true }, outcome: 'ok' }];
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.senior-dev (procedure fix).passed[0]`,
    message: '"inputs.needsTest" is not defined',
  }]);
});

for (const [what, mutate, errors] of [
  ['a Procedure that is null', (c) => { c.procedures.publish = null; },
    [{ at: 'procedures.publish', message: 'a Procedure must be an object' }]],
  ['actions that are a number', (c) => { c.procedures.publish.actions = 3; },
    [{ at: 'procedures.publish', message: 'actions must be a non-empty list' }]],
  ['requires that is a number', (c) => { c.procedures.implement.claims.ok.requires = 3; },
    [{ at: 'procedures.implement.claims.ok', message: 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }' }]],
  ['repeat fields that are a boolean', (c) => { c.procedures.review.actions[2].fields = true; },
    [{ at: 'procedures.review.actions[2]', message: 'fields must be a non-empty list of field names' }]],
  ['a table row that is null', (c) => { c.procedures.review.passed[0] = null; },
    [{ at: 'procedures.review.passed[0]', message: 'a row is { when: { <field>: <condition> }, outcome: <name> }' }]],
  ['routes that are a list', (c) => { c.flows.default.ticket.routes = []; },
    [{ at: 'flows.default.ticket.routes', message: 'routes must be an object from Outcome to target' }]],
  ['inputs that are a number', (c) => { c.flows.default.ticket.vertices.red.inputs = 12; },
    [{ at: `${V}.red.inputs`, message: 'inputs must be an object from name to { from, optional?, pick? }' }]],
  ['an Agent that is a string', (c) => { c.agents.reviewer = 'reviewer.md'; },
    [{ at: `${V}.reviewer`, message: 'agent reviewer must be an object' }]],
  ['flows given as a list', (c) => { c.flows = []; },
    [{ at: 'flows', message: 'flows must be an object from name to Flow' }]],
  ['an Action kind given as a list', (c) => { c.procedures.publish.actions[2] = { id: 'ready', do: ['pr-ready'] }; },
    [{ at: 'procedures.publish.actions[2]', message: 'do ["pr-ready"] is not one of agent, check, commit, push, pr-upsert, pr-ready, comment, await-approval' }]],
  ['a Check kind given as a list', (c) => { c.procedures['base-check'].actions[0].kind = ['command']; },
    [{ at: 'procedures.base-check.actions[0]', message: 'Check kind ["command"] is not one of command, tests-fail, response, repeat' }]],
  ['a command given as a list', (c) => { c.procedures['base-check'].actions[0].command = ['test']; },
    [{ at: 'procedures.base-check.actions[0]', message: 'Check test names command ["test"], which the repository Layer does not declare' }]],
  ['a Procedure name given as a list', (c) => { c.flows.default.ticket.vertices.publish.procedure = ['publish']; },
    [{ at: `${V}.publish`, message: 'procedure ["publish"] is not declared' }]],
  ['a harness given as a list', (c) => { c.agents.reviewer.harness = ['fake']; },
    [{ at: `${V}.reviewer`, message: 'agent reviewer names harness ["fake"], which is not registered' }]],
]) {
  test(`malformed configuration is an error, never a throw: ${what}`, async () => {
    const config = example();
    mutate(config);
    assert.deepEqual((await check(config)).errors, errors);
  });
}

test('a passed row on a Check its token requires failing is unreachable even when another token requires nothing', async () => {
  const config = example();
  config.procedures.implement.claims.partial = { requires: [] };
  config.procedures.implement.passed = [{ when: { claim: 'ok', 'check.test': 'failed' }, outcome: 'odd' }];
  const files = schemas();
  files['implement.schema.json'].properties.claim.enum = ['ok', 'blocked', 'partial'];
  config.procedures.fix.claims.partial = { requires: [] };
  assert.deepEqual((await check(config, files)).errors, [{
    at: 'procedures.implement.passed',
    message: 'rule table implement.passed: row 1 (odd) is unreachable: it matches no input',
  }]);
});

test('a failed row on its token\'s only required Check passing is unreachable', async () => {
  const config = example();
  config.procedures.implement.failed = [{ when: { 'check.test': 'passed' }, outcome: 'odd' }];
  assert.deepEqual((await check(config)).errors, [{
    at: 'procedures.implement.failed',
    message: 'rule table implement.failed: row 1 (odd) is unreachable: it matches no input',
  }]);
});

test('a token whose every passing case a row maps away is not an Outcome', async () => {
  const config = example();
  config.procedures.implement.claims.partial = { requires: ['test'] };
  config.procedures.implement.passed = [{ when: { claim: 'ok' }, outcome: 'done-ish' }];
  const files = schemas();
  files['implement.schema.json'].properties.claim.enum = ['ok', 'blocked', 'partial'];
  config.procedures.fix.claims.partial = { requires: ['test'] };
  config.flows.default.ticket.routes['done-ish'] = 'reviewer';
  const { errors, flows } = await check(config, files);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.green.outcomes,
    ['done-ish', 'partial', 'failed', 'misscoped', 'bad-test', 'blocked', 'harness-timeout', 'harness-transient', 'harness-unparsed']);
});

test('engine outputs have their fields: rescue, evidence and cleanup', async () => {
  const config = example();
  config.flows.default.ticket.vertices.green.inputs.previous.from = 'green.rescue.ref';
  config.flows.default.ticket.vertices.green.inputs.red.from = ['red.red-check.evidence.output', 'senior-red.red-check.cleanup.confirmed'];
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.green.inputs.red`,
    message: 'sources "red.red-check.evidence.output" and "senior-red.red-check.cleanup.confirmed" have different types',
  }]);
});

test('a rescue and a Check\'s evidence are different types', async () => {
  const config = example();
  config.flows.default.ticket.vertices.green.inputs.previous.from = ['green.rescue', 'green.test.evidence'];
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.green.inputs.previous`,
    message: 'sources "green.rescue" and "green.test.evidence" have different types',
  }]);
});

test('schemas that differ only in the order of required or enum are one type', async () => {
  const config = example();
  config.procedures.fix.actions[0].schema = 'fix.schema.json';
  const files = schemas();
  files['fix.schema.json'] = structuredClone(files['implement.schema.json']);
  files['fix.schema.json'].required.reverse();
  files['fix.schema.json'].properties.reason.enum.reverse();
  assert.deepEqual((await check(config, files)).errors, []);
});

test('a configuration that is not an object is one error, not a throw', async () => {
  const validate = await import('../../lib/validate.mjs');
  assert.deepEqual(validate.validate(null, { harnesses: {}, readSchema: () => ({}) }),
    { flows: {}, errors: [{ at: '(root)', message: 'the configuration must be an object' }], warnings: [] });
});

test('a Check\'s evidence and a response object of the same fields are one type', async () => {
  const config = example();
  config.procedures.fix.actions[0].schema = 'fix.schema.json';
  const files = schemas();
  files['fix.schema.json'] = structuredClone(files['implement.schema.json']);
  files['fix.schema.json'].properties.output = {
    type: 'object',
    properties: { command: { type: 'string' }, output: { type: 'string' } },
    required: ['command', 'output'],
    additionalProperties: false,
  };
  files['fix.schema.json'].required.push('output');
  config.flows.default.ticket.vertices.green.inputs.red.from = ['red.red-check.evidence', 'implementer-fix.fix.response.output'];
  config.flows.default.ticket.vertices.reviewer.inputs.report.from = ['green.green.response', 'senior-green.green.response'];
  config.flows.default.ticket.vertices['implementer-fix'].inputs.report.from = ['green.green.response'];
  config.flows.default.ticket.vertices['senior-dev'].inputs.report.from = ['green.green.response'];
  config.flows.default.ticket.vertices.publish.inputs.report.from = ['green.green.response'];
  assert.deepEqual((await check(config, files)).errors, []);
});

test('an unrouted Outcome is an error', async () => {
  const config = example();
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  delete config.flows.default.ticket.vertices.reviewer.route.repeat;
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.reviewer`, message: 'Outcome repeat is not routed by the Vertex or the Flow\'s routes' },
  ]);
});

test('the engine Outcomes default to end: needs-human', async () => {
  const config = example();
  delete config.flows.default.ticket.routes['*'];
  config.flows.default.ticket.routes.blocked = { end: 'needs-human' };
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.failed,
    { target: { end: 'needs-human' }, by: 'engine default', work: 'left in place' });
  assert.deepEqual(flows.default.ticket.vertices.reviewer.routing['harness-timeout'],
    { target: { end: 'needs-human' }, by: 'engine default', work: null });
});

test('a cycle bounded only by the Action Cap is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  assert.deepEqual((await check(config)).errors, [{
    at: 'flows.default.ticket',
    message: 'the cycle through reviewer, implementer-fix has no edge with max and no Vertex with maxVisits; the Action Cap does not bound a cycle',
  }]);
});

test('a cycle through an edge\'s exhausted target is not bounded by that edge\'s max', async () => {
  const config = example();
  config.flows.default.ticket.vertices.reviewer.route.changes = { to: 'implementer-fix', max: 2, exhausted: 'implementer-fix' };
  assert.deepEqual((await check(config)).errors, [{
    at: 'flows.default.ticket',
    message: 'the cycle through reviewer, implementer-fix has no edge with max and no Vertex with maxVisits; the Action Cap does not bound a cycle',
  }]);
});

test('a self-edge with max is a bounded cycle', async () => {
  const config = example();
  config.flows.default.ticket.vertices.baseline.route.failed = { to: 'baseline', max: 2, exhausted: { end: 'needs-human' } };
  assert.deepEqual((await check(config)).errors, []);
});

test('an agentless Vertex may be the entry', async () => {
  const { errors, flows } = await check(example());
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.entry, 'baseline');
  assert.equal(flows.default.ticket.vertices.baseline.agent, null);
});

test('a path to ready-for-qa without pr-ready is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.reviewer.route.ok = { end: 'ready-for-qa' };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.reviewer`, message: 'Outcome ok reaches end ready-for-qa on a route that may skip pr-ready; admission checks routes, not runs, so route it through the Vertex that runs pr-ready' },
  ]);
});

test('pr-ready in a Procedure whose token requires no Check is an error', async () => {
  const config = example();
  config.procedures.publish.actions.shift();
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.publish.actions[1]', message: 'pr-ready publishes only after passing Checks, but Claim token ok requires none' },
  ]);
});

test('a passing write path without a commit is an error', async () => {
  const config = example();
  config.procedures.implement.actions.splice(2, 1);
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.green`, message: 'Vertex green writes, so it must commit on every passing path, but procedure implement has no commit Action' },
    { at: `${V}.senior-green`, message: 'Vertex senior-green writes, so it must commit on every passing path, but procedure implement has no commit Action' },
  ]);
});

test('a write Vertex whose committing token requires no Check is an error', async () => {
  const config = example();
  config.procedures.fix.claims.ok.requires = [];
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.implementer-fix`, message: 'Vertex implementer-fix writes, so its committing Claim token ok must require a Check' },
    { at: `${V}.senior-dev`, message: 'Vertex senior-dev writes, so its committing Claim token ok must require a Check' },
  ]);
});

test('a required input missing on one path is an error', async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.green.inputs.tests.optional;
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.green.inputs.tests`, message: 'input tests is required, but some route to green may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('an optional input no route produces is a warning', async () => {
  const config = example();
  config.flows.default.ticket.vertices['implementer-fix'].inputs.previous = { from: 'publish.rescue', optional: true };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), { at: `${V}.implementer-fix.inputs.previous`, message: 'input previous is optional, but no route to implementer-fix is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs' });
});

test('an unreachable Vertex is a warning', async () => {
  const config = example();
  config.flows.default.ticket.vertices.orphan = { procedure: 'base-check', route: { ok: 'red' } };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), { at: `${V}.orphan`, message: 'Vertex orphan is not reachable from the entry' });
});

test('the example\'s routing reproduces its admission summary', async () => {
  const { errors, warnings, flows } = await check(example());
  const v = flows.default.ticket.vertices;
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.deepEqual(v.baseline.routing.failed, { target: { end: 'needs-human' }, by: 'Flow "*"', work: null });
  assert.deepEqual(v.red.routing.blocked, { target: { end: 'needs-human' }, by: 'Flow "*"', work: 'left in place' });
  assert.deepEqual(v.red.routing['no-test'], { target: 'green', by: 'Vertex route', work: 'rescued' });
  assert.deepEqual(v.green.routing.failed, { target: 'senior-green', by: 'Vertex route', work: 'rescued, or left in place once exhausted' });
  assert.deepEqual(v.green.routing['bad-test'], {
    target: { to: 'red', max: 1, exhausted: { end: 'needs-human' } }, by: 'Vertex route', work: 'rescued, or left in place once exhausted',
  });
  assert.deepEqual(v['implementer-fix'].routing.failed, { target: 'senior-dev', by: 'Vertex route', work: 'rescued, or left in place once exhausted' });
  assert.deepEqual(v['senior-red'].routing['no-test'], { target: 'senior-dev', by: 'Vertex route', work: 'rescued, or left in place once exhausted' });
  assert.deepEqual(v.reviewer.routing.misscoped, { target: { end: 'needs-replan' }, by: 'Flow routes', work: null });
  assert.deepEqual(v.publish.routing.ok, { target: { end: 'ready-for-qa' }, by: 'Vertex route', work: null });
  assert.deepEqual(v.publish.routing.failed, { target: { end: 'needs-human' }, by: 'Flow "*"', work: null });
});

test('the graph checks wait until no other check fails', async () => {
  const config = example();
  config.procedures.implement.actions[1].command = 'lint';
  config.flows.default.ticket.vertices.reviewer.route.changes = 'implementer-fix';
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, [
    { at: 'procedures.implement.actions[1]', message: 'Check test names command "lint", which the repository Layer does not declare' },
  ]);
  assert.deepEqual(flows.default.ticket.vertices.reviewer.routing.changes, { target: 'implementer-fix', by: 'Vertex route', work: null });
});

test('malformed routing is an error, never a throw, in the graph checks', async () => {
  const config = example();
  config.flows.default.ticket.vertices['senior-green'].exhausted = ['nowhere'];
  config.flows.default.ticket.vertices.reviewer.route.retest = { to: 'red', max: 2, exhausted: 7 };
  config.flows.default.ticket.vertices['senior-dev'].maxVisits = 'one';
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.senior-green.exhausted`, message: 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }' },
    { at: `${V}.reviewer.route.retest`, message: 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }' },
    { at: `${V}.senior-dev.maxVisits`, message: 'maxVisits must be a positive integer' },
  ]);
});

test('a required list input is met when each passing token produces a different source', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['a'] }, changes: { requires: ['b'] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
      { id: 'b', do: 'check', kind: 'command', command: 'test' },
    ],
    passed: [{ when: { claim: 'ok' }, outcome: 'go' }, { when: { claim: 'changes' }, outcome: 'go' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: ['judge.a.evidence', 'judge.b.evidence'] } } },
    },
  };
  assert.deepEqual((await check(config)).errors, []);
});

test('the map gives a row\'s Outcome to every Claim token of its table', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['a'] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
    ],
    passed: [{ when: { claim: 'ok' }, outcome: 'go' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.a.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('the map counts a Vertex\'s exhausted target from its first entry', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'start',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      start: { procedure: 'base-check', route: { ok: 'producer' } },
      producer: { procedure: 'base-check', maxVisits: 1, exhausted: 'consumer', route: { ok: 'producer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('the map counts an edge\'s exhausted target from its first traversal', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'start',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      start: { procedure: 'base-check', route: { ok: { to: 'producer', max: 1, exhausted: 'consumer' } } },
      producer: { procedure: 'base-check', route: { ok: 'start' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('a failed Claim guarantees no evidence, so an optional input reading only it is warned', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'producer',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      producer: { procedure: 'base-check', route: { failed: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.test.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is optional, but no route to consumer is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs' });
});

test('a Vertex\'s exhausted target is a landing of every route into it', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'q',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      q: { procedure: 'base-check', route: { ok: { to: 'p', max: 1, exhausted: { end: 'needs-human' } } } },
      p: { procedure: 'base-check', maxVisits: 1, exhausted: { end: 'ready-for-qa' }, route: { ok: 'q' } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: 'flows.default.ticket.vertices.q', message: 'Outcome ok reaches end ready-for-qa on a route that may skip pr-ready; admission checks routes, not runs, so route it through the Vertex that runs pr-ready' },
  ]);
});

test('the map counts a maxVisits above 1 as spent from the first entry', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'a',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      a: { procedure: 'base-check', maxVisits: 2, exhausted: 'consumer', route: { ok: 'b' } },
      b: { procedure: 'base-check', maxVisits: 1, exhausted: 'c', route: { ok: 'a' } },
      c: { procedure: 'base-check', route: { ok: 'a' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'c.test.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('the map gives a row taken by an earlier row its Outcome for every token', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['a'] }, changes: { requires: ['b'] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
      { id: 'b', do: 'check', kind: 'command', command: 'test' },
    ],
    passed: [{ when: { claim: 'ok' }, outcome: 'a-go' }, { when: {}, outcome: 'b-go' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'b-go': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.b.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('a failed Claim guarantees no evidence of a later required Check, so an optional input reading it is warned', async () => {
  const config = example();
  config.procedures.both = {
    actions: [
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
      { id: 'b', do: 'check', kind: 'command', command: 'test' },
    ],
  };
  config.flows.default.ticket = {
    entry: 'producer',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      producer: { procedure: 'both', route: { failed: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'producer.b.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is optional, but no route to consumer is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs' });
});

test('the map takes no evidence from the stopped table, whatever a row names', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['test'] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'test', do: 'check', kind: 'command', command: 'test' },
    ],
    stopped: [{ when: { 'check.test': 'passed' }, outcome: 'has-evidence' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'has-evidence': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.test.evidence' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('a stopped Claim guarantees no evidence, so an optional input reading it is warned', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['test'] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'test', do: 'check', kind: 'command', command: 'test' },
    ],
    stopped: [{ when: { 'check.test': 'failed' }, outcome: 'no-evidence' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'no-evidence': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.test.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is optional, but no route to consumer is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs' });
});

test('a Check named after an Object property is analysed, never a throw', async () => {
  const config = example();
  config.procedures.gate = {
    actions: [{ id: 'constructor', do: 'check', kind: 'command', command: 'test' }],
    passed: [{ when: { 'check.constructor': 'passed' }, outcome: 'ok' }],
  };
  config.flows.default.ticket = {
    entry: 'gate',
    routes: { '*': { end: 'needs-human' } },
    vertices: { gate: { procedure: 'gate' } },
  };
  assert.deepEqual((await check(config)).errors, []);
});

test('the map takes no evidence from stopped rows, even when each needs a different Check passed', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: [] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
      { id: 'b', do: 'check', kind: 'command', command: 'test' },
    ],
    stopped: [{ when: { 'check.a': 'passed' }, outcome: 'go' }, { when: { 'check.b': 'passed' }, outcome: 'go' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: ['judge.a.evidence', 'judge.b.evidence'] } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.consumer.inputs.evidence`, message: 'input evidence is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional' },
  ]);
});

test('a row partly taken only across Claim tokens is warned once', async () => {
  const config = example();
  // In token ok's inputs row 1 takes all of row 2; in token changes' row 2 is free. Together it is partly taken.
  config.procedures.review.passed = [{ when: { claim: 'ok' }, outcome: 'ok' }, { when: {}, outcome: 'other' }];
  // The reviewer still loops back, so the Flow's inputs keep a producing path; with no changes, implementer-fix is cut off.
  config.flows.default.ticket.vertices.reviewer.route.other = { to: 'red', max: 2, exhausted: 'senior-red' };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [{
    at: 'procedures.review.passed',
    message: 'rule table review.passed: row 2 (no conditions) is partly taken by row 1 (claim = ok), for example {"claim":"ok"}',
  }, { at: `${V}.implementer-fix`, message: 'Vertex implementer-fix is not reachable from the entry' }]);
});

test('an explicit Flow route beats the Vertex\'s "*"', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.route['*'] = { end: 'needs-human' };
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.misscoped, { target: { end: 'needs-replan' }, by: 'Flow routes', work: 'left in place' });
  assert.deepEqual(flows.default.ticket.vertices.red.routing.blocked, { target: { end: 'needs-human' }, by: 'Vertex "*"', work: 'left in place' });
});

test('a bound without an exhausted target is an error', async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.green.route['bad-test'].exhausted;
  delete config.flows.default.ticket.vertices['senior-dev'].exhausted;
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.green.route.bad-test`, message: 'an edge with max names its exhausted target' },
    { at: `${V}.senior-dev`, message: 'a Vertex with maxVisits names its exhausted target' },
  ]);
});

test('a Vertex whose Agent sets no access is read-only', async () => {
  const config = example();
  delete config.agents.implementer.access;
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, []);
  assert.equal(flows.default.ticket.vertices.red.access, 'read-only');
  assert.equal(flows.default.ticket.vertices.baseline.access, 'read-only');
  assert.equal(flows.default.ticket.vertices['senior-red'].access, 'workspace-write');
});

test('an optional input that only some ways of an Outcome produce is warned', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: ['a'] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [
      { id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'a', do: 'check', kind: 'command', command: 'test' },
    ],
    passed: [{ when: { claim: 'ok' }, outcome: 'go' }, { when: { claim: 'changes' }, outcome: 'go' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { go: 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { evidence: { from: 'judge.a.evidence', optional: true } } },
    },
  };
  const { errors, warnings } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.at(-1), {
    at: `${V}.consumer.inputs.evidence`,
    message: 'input evidence is optional, but no route to consumer is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs',
  });
});

test('a harness failure leaves no response', async () => {
  const config = example();
  config.procedures.judge = {
    access: 'read-only',
    claims: { ok: { requires: [] }, changes: { requires: [] }, blocked: { stop: true } },
    actions: [{ id: 'judge', do: 'agent', brief: 'review.md', schema: 'review.schema.json' }],
  };
  config.flows.default.ticket = {
    entry: 'judge',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      judge: { use: 'reviewer', procedure: 'judge', route: { 'harness-timeout': 'consumer' } },
      consumer: { procedure: 'base-check', inputs: { report: { from: 'judge.judge.response' } } },
    },
  };
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.consumer.inputs.report`,
    message: 'input report is required, but some route to consumer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional',
  }]);
});

test('pr-ready counts only from the passed table', async () => {
  const config = example();
  config.procedures.ship = {
    access: 'read-only',
    claims: { ok: { requires: ['test'] }, changes: { requires: ['test'] }, blocked: { stop: true } },
    actions: [
      { id: 'ship', do: 'agent', brief: 'review.md', schema: 'review.schema.json' },
      { id: 'test', do: 'check', kind: 'command', command: 'test' },
      { id: 'pr-ready', do: 'pr-ready' },
    ],
  };
  config.flows.default.ticket = {
    entry: 'ship',
    routes: { '*': { end: 'needs-human' } },
    vertices: { ship: { use: 'reviewer', procedure: 'ship', route: { ok: { end: 'ready-for-qa' }, blocked: { end: 'ready-for-qa' } } } },
  };
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.ship`,
    message: 'Outcome blocked reaches end ready-for-qa on a route that may skip pr-ready; admission checks routes, not runs, so route it through the Vertex that runs pr-ready',
  }]);
});

test('a passing Outcome leaves no rescue', async () => {
  const config = example();
  config.flows.default.ticket.vertices.reviewer.inputs.previous = { from: 'green.rescue' };
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.reviewer.inputs.previous`,
    message: 'input previous is required, but some route to reviewer may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional',
  }]);
});

test('a read-only Vertex leaves no rescue', async () => {
  const config = example();
  config.flows.default.ticket.vertices.green.access = 'read-only';
  delete config.flows.default.ticket.vertices['senior-green'].inputs.previous.optional;
  assert.deepEqual((await check(config)).errors, [{
    at: `${V}.senior-green.inputs.previous`,
    message: 'input previous is required, but some route to senior-green may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional',
  }]);
});

test('a Vertex\'s own route for an Outcome beats the Flow\'s', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.route.misscoped = { end: 'needs-human' };
  const { errors, flows } = await check(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.red.routing.misscoped, { target: { end: 'needs-human' }, by: 'Vertex route', work: 'left in place' });
});

test('a loop of exhausted targets is an error', async () => {
  const config = example();
  config.flows.default.ticket = {
    entry: 'start',
    routes: { '*': { end: 'needs-human' } },
    vertices: {
      start: { procedure: 'base-check', route: { ok: 'x' } },
      x: { procedure: 'base-check', maxVisits: 1, exhausted: 'y', route: { ok: 'y' } },
      y: { procedure: 'base-check', maxVisits: 1, exhausted: 'x', route: { ok: 'x' } },
    },
  };
  assert.deepEqual((await check(config)).errors, [{
    at: 'flows.default.ticket',
    message: 'the exhausted targets of x, y form a loop: once their maxVisits are spent, no Vertex is ever entered',
  }]);
});

test('an exhausted target without a bound is an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.exhausted = { end: 'needs-human' };
  config.flows.default.ticket.vertices.green.route.ok = { to: 'reviewer', exhausted: { end: 'needs-human' } };
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.red`, message: 'a Vertex names exhausted only with maxVisits' },
    { at: `${V}.green.route.ok`, message: 'an edge names exhausted only with max' },
  ]);
});

test('a Flow\'s graph checks wait only for its own errors and those outside every Flow, in either order', async () => {
  const unrouted = { plan: null, actionCap: 20, ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } } };
  const misspelt = { plan: null, actionCap: 20, ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check', rout: {}, route: { ok: { end: 'needs-human' } } } } } };
  const first = example();
  first.flows = { unrouted, misspelt };
  assert.deepEqual((await check(first)).errors, [
    { at: 'flows.unrouted.ticket.vertices.gate', message: 'Outcome ok is not routed by the Vertex or the Flow\'s routes' },
    { at: 'flows.misspelt.ticket.vertices.gate', message: 'unknown key "rout"' },
  ]);
  const second = example();
  second.flows = { misspelt, unrouted };
  assert.deepEqual((await check(second)).errors, [
    { at: 'flows.misspelt.ticket.vertices.gate', message: 'unknown key "rout"' },
    { at: 'flows.unrouted.ticket.vertices.gate', message: 'Outcome ok is not routed by the Vertex or the Flow\'s routes' },
  ]);
});

test('an error outside every Flow holds every Flow\'s graph checks', async () => {
  const config = example();
  config.procedures['base-check'].actions[0].command = 'lint';
  config.flows.light = { plan: null, actionCap: 20, ticket: { entry: 'gate', vertices: { gate: { procedure: 'base-check' } } } };
  assert.deepEqual((await check(config)).errors, [
    { at: 'procedures.base-check.actions[0]', message: 'Check test names command "lint", which the repository Layer does not declare' },
  ]);
});
