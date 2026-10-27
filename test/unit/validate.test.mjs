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
  assert.deepEqual((await check(config)).errors, [
    { at: `${V}.cleanup`, message: 'Vertex id "cleanup" is reserved: an end name, cleanup or done' },
    { at: `${V}.done`, message: 'Vertex id "done" is reserved: an end name, cleanup or done' },
    { at: `${V}.needs-human`, message: 'Vertex id "needs-human" is reserved: an end name, cleanup or done' },
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
    at: `${V}.senior-dev (procedure fix).passed`,
    message: '"inputs.needsTest" is not defined',
  }]);
});
