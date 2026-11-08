import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as fakeGh from '../support/fake-gh.ts';

// A case that asks nobody reads no labels.
const DEPS = {
  harnesses: { fake: {} },
  gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh),
  cwd: '/repo',
};
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// The example Layer as loadLayers gives it: its schemas loaded beside it, and a template naming nothing for each
// template it names (its own templates arrive with #120).
function example() {
  const layer = exampleLayer.config();
  layer.files = Object.fromEntries([
    ...exampleLayer.SCHEMA_NAMES.map((name) => [name, file(exampleLayer.fixtureText(name))]),
    ...Object.entries(exampleLayer.templates()).map(([name, text]) => [name, file(text)]),
  ]);
  return layer;
}

test("gg doctor prints each Vertex's Procedure, Checks, tables and Outcomes", async () => {
  const { text, exitCode } = await doctor.doctor({ config: example(), ...DEPS });
  assert.equal(text, exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n'));
  assert.equal(exitCode, 0);
});

test('gg doctor reports a malformed table row rather than throwing', async () => {
  const config = example();
  config.procedures.review.passed[0] = null;
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(text.includes('\n  passed:\n    1. no conditions -> no outcome\n'), text);
  assert.ok(
    text.includes(
      '\nerror: procedures.review.passed[0]: a row is { when: { <field>: <condition> }, outcome: <name> } ' +
        '[malformed-row]\n',
    ),
    text,
  );
});

// The code goes last, as ESLint prints a rule id, so each line keeps the prefix it had.
test('an error line ends in its code', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(
    text.includes(
      '\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared [undeclared-procedure]\n',
    ),
    text,
  );
});

test('a warning line ends in its code', async () => {
  const config = example();
  config.agents.spare = { harness: 'fake' };
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\nwarning: agents.spare: agent spare is used by no Vertex [unused-agent]\n'), text);
});

test("gg doctor says a row's outcome is missing when the row leaves it out", async () => {
  const config = example();
  delete config.procedures['tests-fail'].stopped[0].outcome;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  stopped:\n    1. response.reason = misscoped -> no outcome\n'), text);
});

test('gg doctor says tests name nothing when tests leaves out named', async () => {
  const config = example();
  config.procedures.fix.tests = {};
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  tests: named nothing\n'), text);
});

test("gg doctor says a Vertex's procedure is none when the Vertex leaves it out", async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.baseline.procedure;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\nvertex baseline\n  procedure: none\n'), text);
});

test("gg doctor says a Check's kind is missing when the Check leaves it out", async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].kind;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  checks: test (no kind test)\n'), text);
});

test("gg doctor says a Check's id is missing when the Check leaves it out", async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].id;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  checks: no id (command test)\n'), text);
});

test("gg doctor says an Edge's target is missing when the Edge leaves out to", async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.reviewer.route.retest.to;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n    retest -> no target (max 2, exhausted senior-red)\n'), text);
});

test('gg doctor says a Claim token requires a Check with no id when the Check leaves it out', async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].id;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  claimTokens: ok requires no id\n'), text);
});

test('gg doctor says an input has no source when it leaves out from', async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.red.inputs.findings.from;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n    findings <- no source (optional)\n'), text);
});

test('gg doctor exits non-zero on an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.endsWith(
      '\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared [undeclared-procedure]\n' +
        '1 error, 2 warnings\n',
    ),
    text,
  );
});

test('gg doctor reports a Procedure name with a colon at its location', async () => {
  const config = example();
  config.procedures['base:check'] = config.procedures['base-check'];
  delete config.procedures['base-check'];
  config.flows.default.ticket.vertices.baseline.procedure = 'base:check';
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      '\nerror: procedures.base:check: Procedure "base:check" must be non-empty with no ":", ".", "/", "--" or ' +
        'whitespace [invalid-name]\n',
    ),
    text,
  );
});

test("gg doctor reports an Agent's access outside the Permission Intents at agents.<name>.access", async () => {
  const config = example();
  config.agents.implementer.access = 'read-write';
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.endsWith(
      '\nerror: agents.implementer.access: access "read-write" is not a Permission Intent: read-only or ' +
        'workspace-write [unknown-permission-intent]\n1 error, 2 warnings\n',
    ),
    text,
  );
});

test('gg doctor reports an Outcome named after an Object.prototype property as reserved', async () => {
  const config = example();
  config.procedures['tests-fail'].stopped[0].outcome = 'toString';
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.equal(
    text,
    'error: procedures.tests-fail.stopped[0]: outcome "toString" is reserved: every object inherits a property of ' +
      'that name from Object.prototype [inherited-name]\n1 error\n',
  );
});

test('gg doctor reads schemas from the loaded Layer files', async () => {
  const config = example();
  const schema = JSON.parse(config.files['review.schema.json'].bytes);
  schema.properties.claim.enum = ['ok', 'changes'];
  config.files['review.schema.json'] = file(JSON.stringify(schema));
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      '\nerror: procedures.review.claimTokens: review.schema.json: claim: enum "ok" | "changes" does not equal the ' +
        'declared tokens "ok" | "changes" | "blocked" [claim-enum-mismatch]\n',
    ),
    text,
  );
});

test('gg doctor accepts the shipped defaults once a harness is set', async () => {
  const shipped: exampleLayer.Layer = config.loadDefaults();
  shipped.agents.implementer.harness = 'fake';
  shipped.agents.reviewer.harness = 'fake';
  shipped.commands = { test: 'npm test' };
  const { text, exitCode } = await doctor.doctor({ config: shipped, ...DEPS });
  assert.ok(text.startsWith('flow default\n  actionCap: 180\n  entry: red\n'), text);
  // The example's intended overlap (U4): a clean ok whose findings repeat earlier ones stays ok.
  assert.ok(
    text.endsWith(
      '\nwarning: procedures.review.passed: rule table review.passed: ' +
        'row 2 (check.repeat = failed) is partly taken by ' +
        'row 1 (claim = ok and check.review-pass = passed), ' +
        'for example {"claim":"ok","check":{"review-pass":"passed","repeat":"failed"}} [overlapping-rows]\n' +
        '0 errors, 1 warning\n',
    ),
    text,
  );
  assert.equal(exitCode, 0);
});

const AWAIT_LABEL = 'gg:await:approve';
const APPROVED_LABEL = 'gg:decide:approve:approved';
const REJECTED_LABEL = 'gg:decide:approve:rejected';

// The example with a Vertex that asks a human.
function asking() {
  const config = example();
  config.procedures.approval = { actions: [{ id: 'ask', do: 'await-approval' }] };
  config.flows.default.ticket.vertices.approve = {
    procedure: 'approval',
    route: { approved: { end: 'needs-human' }, rejected: { end: 'needs-replan' } },
  };
  return config;
}
const repository = (...labels: string[]) =>
  github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1, repoLabels: labels }).gh);

test('gg doctor prints the Await and Decide Labels of a Vertex that asks, and each Decision routes', async () => {
  const gh = repository(AWAIT_LABEL, APPROVED_LABEL, REJECTED_LABEL);
  const { text, exitCode } = await doctor.doctor({ config: asking(), harnesses: { fake: {} }, gh, cwd: '/repo' });
  assert.equal(exitCode, 0, text);
  assert.ok(text.includes(`\n  approval labels: ${AWAIT_LABEL}, ${APPROVED_LABEL}, ${REJECTED_LABEL}\n`), text);
  assert.ok(text.includes('\n    approved -> end needs-human\n'), text);
  assert.ok(text.includes('\n    rejected -> end needs-replan\n'), text);
  assert.ok(!text.includes('missing from the repository'), text);
});

test('gg doctor reports the labels a Flow can request that the repository lacks', async () => {
  const gh = repository(AWAIT_LABEL);
  const { text, exitCode } = await doctor.doctor({ config: asking(), harnesses: { fake: {} }, gh, cwd: '/repo' });
  assert.equal(exitCode, 0, 'gg run creates them');
  assert.ok(
    text.includes(
      `\nwarning: flows.default.ticket.vertices.approve: labels missing from the repository: ` +
        `${APPROVED_LABEL}, ${REJECTED_LABEL}\n`,
    ),
    text,
  );
});

test("gg doctor says when it cannot read the repository's labels", async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  fake.fail({ matches: () => true, status: 502 });
  const { text, exitCode } = await doctor.doctor({
    config: asking(),
    harnesses: { fake: {} },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.equal(exitCode, 0);
  assert.match(text, /warning: could not read the repository's labels: /);
});

test('gg doctor reads no labels for a Flow that asks nobody', async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  await doctor.doctor({ config: example(), harnesses: { fake: {} }, gh: github.createGh(fake.gh), cwd: '/repo' });
  assert.deepEqual(fake.calls, []);
});
