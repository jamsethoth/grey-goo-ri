import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as namedFlow from '../support/named-flow.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// A case that asks nobody reads no labels.
const DEPS = {
  harnesses: { fake: {} },
  gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh),
  cwd: '/repo',
};
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// The example Layer as loadLayers gives it: every file it names loaded beside it.
function example() {
  const layer = exampleLayer.config();
  layer.files = Object.fromEntries(
    exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json').map((name) => [
      name,
      file(exampleLayer.fixtureText(name)),
    ]),
  );
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

// gg doctor and gg run preflight check the same repository Layer, so doctor never passes what run refuses (#301).
test('gg doctor reports the repository Layer problems gg run preflight refuses', async () => {
  const layer = example();
  layer.commands = { ...layer.commands, Test: 'npm test' };
  const { text, exitCode } = await doctor.doctor({ config: layer, ...DEPS });
  assert.equal(exitCode, 1);
  const file = config.layerPath(DEPS.cwd);
  assert.ok(
    text.includes(`\nerror: commands: ${file}: command name "Test" must match [a-z][a-z0-9-]* [invalid-name]\n`),
    text,
  );
});

// Doctor lists the repository Layer's problems first, as gg run preflight does, so the two read the same (#301).
test("gg doctor prints the repository Layer's errors before the Flows', as preflight does", async () => {
  const layer = example();
  layer.commands = { ...layer.commands, Test: 'npm test' };
  layer.flows.default.ticket.vertices.red.procedure = 'red';
  const { text } = await doctor.doctor({ config: layer, ...DEPS });
  assert.deepEqual(
    text
      .split('\n')
      .filter((line) => line.startsWith('error: '))
      .map((line) => line.slice('error: '.length, line.indexOf(': ', 'error: '.length))),
    ['commands', 'flows.default.ticket.vertices.red'],
  );
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

// An id that is not a string is kept out of every collection keyed by id, so no Claim token requires it (#174).
test('gg doctor lists a Check with no id, which no Claim token requires', async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].id;
  const { text } = await doctor.doctor({ config, ...DEPS });
  assert.ok(text.includes('\n  checks: no id (command test)\n  claimTokens: ok requires none\n'), text);
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

// A repository and a home directory for `gg init`, neither holding a Layer yet.
function initRoots(t: TestContext) {
  const directory = tempDirectory.tempDirectory(t, 'gg-init-');
  return { repo: join(directory, 'repo'), home: join(directory, 'home') };
}
const layerDirectory = (root: string) => join(root, '.agents', 'gg');

test('gg init writes the example and gg doctor accepts it', async (t) => {
  const { repo, home } = initRoots(t);
  const text = doctor.init(repo);
  const written = layerDirectory(repo);
  assert.deepEqual(readdirSync(written).sort(), [...exampleLayer.WRITTEN_NAMES].sort(), 'every file but doctor.txt');
  for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
    assert.equal(readFileSync(join(written, name), 'utf8'), exampleLayer.fixtureText(name), name);
  const layer = JSON.parse(readFileSync(join(written, 'gg.json'), 'utf8'));
  const expected = JSON.parse(exampleLayer.fixtureText('gg.json'));
  delete expected.commands.test;
  assert.deepEqual(layer, expected, "the fixture's gg.json with commands.test removed");
  // The advice gg init gives the person who runs it (L9, J11).
  assert.match(text, /read-only default workflow permissions/);
  assert.match(text, /assumes the test command is deterministic/);

  // A test command added, and each example user Layer, which names the Harnesses.
  layer.commands.test = 'npm test';
  writeFileSync(join(written, 'gg.json'), JSON.stringify(layer));
  mkdirSync(layerDirectory(home), { recursive: true });
  for (const example of ['claude.json', 'codex.json']) {
    copyFileSync(join(config.EXAMPLES_DIRECTORY, example), config.layerPath(home));
    const accepted = await doctor.doctor({
      config: config.loadLayers(repo, home),
      harnesses: shipped.HARNESSES,
      gh: DEPS.gh,
      cwd: repo,
    });
    assert.equal(accepted.exitCode, 0, `${example}\n${accepted.text}`);
    assert.match(accepted.text, /\n0 errors, 2 warnings\n$/, example);
  }
});

test('gg init keeps an existing Layer, says so and exits successfully', (t) => {
  // It returns what it says, and throws only on a failed write, so gg exits 0 (test/e2e/gg.test.ts).
  const { repo } = initRoots(t);
  mkdirSync(layerDirectory(repo), { recursive: true });
  const kept = '{ "commands": { "test": "make test" } }\n';
  writeFileSync(config.layerPath(repo), kept);
  assert.equal(
    doctor.init(repo),
    `gg init kept the existing Layer and wrote nothing: ${config.layerPath(repo)} exists.\n`,
  );
  assert.deepEqual(readdirSync(layerDirectory(repo)), ['gg.json']);
  assert.equal(readFileSync(config.layerPath(repo), 'utf8'), kept);
});

test('gg init writes nothing over any file it would write', (t) => {
  const { repo } = initRoots(t);
  mkdirSync(layerDirectory(repo), { recursive: true });
  const red = join(layerDirectory(repo), 'red.md');
  writeFileSync(red, '# our own red Brief\n');
  assert.equal(doctor.init(repo), `gg init kept the existing Layer and wrote nothing: ${red} exists.\n`);
  assert.deepEqual(readdirSync(layerDirectory(repo)), ['red.md']);
});

// This repository's Layer was merged by hand from gg init's output (#120), so it runs on the example's own Flow.
test(
  "this repository's Layer is the example with its own commands and testPaths, " + 'and gg doctor accepts it',
  async (t) => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const own = JSON.parse(readFileSync(config.layerPath(repoRoot), 'utf8'));
    const example = JSON.parse(exampleLayer.fixtureText('gg.json'));
    assert.deepEqual(
      { ...own, commands: undefined, testPaths: undefined },
      { ...example, commands: undefined, testPaths: undefined },
    );
    for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
      assert.equal(readFileSync(join(layerDirectory(repoRoot), name), 'utf8'), exampleLayer.fixtureText(name), name);
    const { home } = initRoots(t);
    mkdirSync(layerDirectory(home), { recursive: true });
    copyFileSync(join(config.EXAMPLES_DIRECTORY, 'claude.json'), config.layerPath(home));
    const { text, exitCode } = await doctor.doctor({
      config: config.loadLayers(repoRoot, home),
      harnesses: shipped.HARNESSES,
      gh: DEPS.gh,
      cwd: repoRoot,
    });
    assert.equal(exitCode, 0, text);
    assert.match(text, /\n0 errors, 2 warnings\n$/);
  },
);

// The harness, model and effort come from the user Layer (P2).
test("the example's Agents name no harness, model or effort", () => {
  const { agents } = JSON.parse(exampleLayer.fixtureText('gg.json'));
  assert.deepEqual(agents, {
    implementer: { persona: 'implementer.md', access: 'workspace-write' },
    reviewer: { persona: 'reviewer.md', access: 'read-only' },
    senior: { persona: 'implementer.md', access: 'workspace-write' },
  });
});

test("the example declares its Procedures in the validator's shape", () => {
  const { flows, errors } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.exampleTemplates(),
  );
  assert.deepEqual(errors, []);
  const actions = (name: string) =>
    flows.default.procedures[name].actions.map((action) => [action.id, action.do].join(':'));
  assert.deepEqual(actions('base-check'), ['test:check']);
  assert.deepEqual(actions('tests-fail'), ['red:agent', 'red-check:check', 'commit:commit']);
  assert.deepEqual(actions('implement'), ['green:agent', 'test:check', 'commit:commit', 'push:push', 'pr:pr-upsert']);
  assert.deepEqual(actions('fix'), ['fix:agent', 'test:check', 'commit:commit', 'push:push', 'pr:pr-upsert']);
  assert.deepEqual(actions('review'), [
    'review:agent',
    'review-pass:check',
    'repeat:check',
    'comment:comment',
    'pr:pr-upsert',
  ]);
  assert.deepEqual(actions('publish'), ['test:check', 'pr:pr-upsert', 'pr-ready:pr-ready']);
});

test("the example's schemas spell the Definition of Done and the red and green evidence in full", () => {
  const required = (name: string) => JSON.parse(exampleLayer.fixtureText(`${name}.schema.json`)).required;
  assert.deepEqual(required('implement'), [
    'claim',
    'reason',
    'summary',
    'definitionOfDone',
    'qa',
    'diagnosis',
    'notes',
  ]);
  assert.deepEqual(required('review'), [
    'claim',
    'reason',
    'summary',
    'definitionOfDoneMet',
    'redGreenEvidenceOk',
    'needsTest',
    'findings',
    'diagnosis',
  ]);
});

test('every template the example writes names only declared inputs at every Vertex that uses it', () => {
  const { errors, warnings } = exampleLayer.check(
    exampleLayer.config(),
    exampleLayer.schemas(),
    exampleLayer.exampleTemplates(),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    warnings.map((warning) => `${warning.at} ${warning.code}`),
    ['procedures.review.passed overlapping-rows', 'procedures.review.passed overlapping-rows'],
  );
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
        `${APPROVED_LABEL}, ${REJECTED_LABEL} [repository-labels-missing]\n`,
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
  assert.match(text, /\nwarning: could not read the repository's labels: .* \[repository-labels-unread\]\n/);
});

test('gg doctor reads no labels for a Flow that asks nobody', async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  await doctor.doctor({ config: example(), harnesses: { fake: {} }, gh: github.createGh(fake.gh), cwd: '/repo' });
  assert.deepEqual(fake.calls, []);
});

test('gg doctor prints a Flow named entirely with Object.prototype names like one with ordinary names', async () => {
  const print = (names: namedFlow.Names) =>
    doctor.doctor({ config: namedFlow.namedConfig(names) as unknown as config.Config, ...DEPS });
  const ordinary = await print(namedFlow.ORDINARY);
  // Its one command is named for the comparison, which the repository Layer's command rule refuses, as gg run
  // preflight does (#301); the Flow itself is clean.
  assert.deepEqual(
    ordinary.text.split('\n').filter((line) => line.startsWith('error: ') && !line.startsWith('error: commands: ')),
    [],
  );
  assert.deepEqual(await print(namedFlow.PROTOTYPE), namedFlow.renamed(ordinary));
});

// The example's one Flow is printed again under its second name, after the first, and its findings once.
test('gg doctor prints each declared Flow, in the order the Layer declares them', async () => {
  const config = example();
  config.flows.light = structuredClone(config.flows.default);
  const { text, exitCode } = await doctor.doctor({ config, ...DEPS });
  const one = exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n');
  const flowSection = one.slice(0, one.indexOf('\nwarning: ') + 1);
  assert.equal(text, one.replace(flowSection, flowSection + flowSection.replace('flow default\n', 'flow light\n')));
  assert.equal(exitCode, 0);
});
