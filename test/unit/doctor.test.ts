import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as namedFlow from '../support/named-flow.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// A Harness that passes preflight, as gg run's admission checks it.
const FAKE_HARNESS = fakeHarness.fakeHarness();
// A case that asks nobody reads no labels.
const DEPS = {
  harnesses: { fake: FAKE_HARNESS },
  gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh),
  cwd: '/repo',
};
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });
const REPOSITORY_FILE = '/repo/.agents/gg/gg.json';
const USER_FILE = '/home/.agents/gg/gg.json';

// `repository` as the repository's source, beside a user source that holds only the machine settings, or `user`.
const sources = (
  repository: config.Source,
  user: config.Source = { maxParallel: 2, worktreeRoot: '~/worktrees', files: {} },
): config.Configuration => ({ repository, user, repositoryFile: REPOSITORY_FILE, userFile: USER_FILE });

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
  const { text, exitCode } = await doctor.doctor({ config: sources(example()), ...DEPS });
  assert.equal(text, exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n'));
  assert.equal(exitCode, 0);
});

test('gg doctor reports a malformed table row rather than throwing', async () => {
  const config = example();
  config.procedures.review.passed[0] = null;
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
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
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(
    text.includes(
      '\nerror: flows.default.ticket.vertices.red: procedure "red" is not declared [undeclared-procedure]\n',
    ),
    text,
  );
});

test('a warning line ends in its code', async () => {
  const config = example();
  config.agents.spare = { harness: 'fake', persona: 'implementer.md' };
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\nwarning: agents.spare: agent spare is used by no Vertex [unused-agent]\n'), text);
});

// gg doctor and gg run preflight check the same repository contract, so doctor never passes what run refuses (#301).
test('gg doctor reports the repository contract problems gg run preflight refuses', async () => {
  const layer = example();
  layer.commands = { ...layer.commands, Test: 'npm test' };
  const { text, exitCode } = await doctor.doctor({ config: sources(layer), ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      `\nerror: commands: ${REPOSITORY_FILE}: command name "Test" must match [a-z][a-z0-9-]* [invalid-name]\n`,
    ),
    text,
  );
});

// Doctor lists the settings' problems first, as gg run preflight does, so the two read the same (#301).
test("gg doctor prints the repository contract's errors before the Flows', as preflight does", async () => {
  const layer = example();
  layer.commands = { ...layer.commands, Test: 'npm test' };
  layer.flows.default.ticket.vertices.red.procedure = 'red';
  const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
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
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n  stopped:\n    1. response.reason = misscoped -> no outcome\n'), text);
});

test('gg doctor says tests name nothing when tests leaves out named', async () => {
  const config = example();
  config.procedures.fix.tests = {};
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n  tests: named nothing\n'), text);
});

test("gg doctor says a Vertex's procedure is none when the Vertex leaves it out", async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.baseline.procedure;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\nvertex baseline\n  procedure: none\n'), text);
});

test("gg doctor says a Check's kind is missing when the Check leaves it out", async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].kind;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n  checks: test (no kind test)\n'), text);
});

test("gg doctor says a Check's id is missing when the Check leaves it out", async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].id;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n  checks: no id (command test)\n'), text);
});

test("gg doctor says an Edge's target is missing when the Edge leaves out to", async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.reviewer.route.retest.to;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n    retest -> no target (max 2, exhausted senior-red)\n'), text);
});

// An id that is not a string is kept out of every collection keyed by id, so no Claim token requires it (#174).
test('gg doctor lists a Check with no id, which no Claim token requires', async () => {
  const config = example();
  delete config.procedures['base-check'].actions[0].id;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n  checks: no id (command test)\n  claimTokens: ok requires none\n'), text);
});

test('gg doctor says an input has no source when it leaves out from', async () => {
  const config = example();
  delete config.flows.default.ticket.vertices.red.inputs.findings.from;
  const { text } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.ok(text.includes('\n    findings <- no source (optional)\n'), text);
});

test('gg doctor exits non-zero on an error', async () => {
  const config = example();
  config.flows.default.ticket.vertices.red.procedure = 'red';
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
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
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
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
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.endsWith(
      '\nerror: agents.implementer.access: access "read-write" is not a Permission Intent: read-only or ' +
        'workspace-write [unknown-permission-intent]\n1 error, 2 warnings\n',
    ),
    text,
  );
});

test("gg doctor reports an Agent's model that is not a string at agents.<name>.model", async () => {
  const config = example();
  config.agents.implementer.model = 7;
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.equal(exitCode, 1);
  assert.match(text, /\nerror: agents\.implementer\.model: .*\[not-a-string\]\n/);
});

test('gg doctor reads schemas from the loaded Layer files', async () => {
  const config = example();
  const schema = JSON.parse(config.files['review.schema.json'].bytes) as { properties: { claim: { enum: string[] } } };
  schema.properties.claim.enum = ['ok', 'changes'];
  config.files['review.schema.json'] = file(JSON.stringify(schema));
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
  assert.equal(exitCode, 1);
  assert.ok(
    text.includes(
      '\nerror: procedures.review.claimTokens: review.schema.json: claim: enum "ok" | "changes" does not equal the ' +
        'declared tokens "ok" | "changes" | "blocked" [claim-enum-mismatch]\n',
    ),
    text,
  );
});

const dbPath = (commonDir: string) => join(commonDir, 'gg', 'gg.db');
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// Only gg init creates the State Database (#150), so doctor names a missing one, as gg run's preflight does.
test('gg doctor reports a missing State Database as an error naming gg init', async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-doctor-records-');
  const { text, exitCode } = await doctor.doctor({ config: sources(example()), ...DEPS, commonDir });
  assert.equal(exitCode, 1, text);
  assert.ok(
    text.includes(`\nerror: no State Database at ${dbPath(commonDir)}: run gg init [state-database-missing]\n`),
    text,
  );
  assert.equal(existsSync(join(commonDir, 'gg')), false, 'no gg directory');
});

// A user Flow that names a command the repository does not declare is only a warning in gg doctor: the user's
// directory serves every repository, and gg run refuses the Flow only when it is selected (Q21).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('gg doctor warns of a user Flow that names a command the repository does not declare, and names its source', async () => {
  const repository = example();
  const user = { ...example(), ...MACHINE_SETTINGS };
  delete user.commands;
  delete user.testPaths;
  delete user.labelPrefix;
  delete user.baseBranch;
  user.flows = { strict: user.flows.default };
  user.procedures['base-check'].actions[0].command = 'lint';
  const { text, exitCode } = await doctor.doctor({ config: sources(repository, user), ...DEPS });
  assert.equal(exitCode, 0, text);
  assert.ok(text.startsWith('flow default\n  source: repository\n'), text);
  assert.ok(text.includes('\nflow user:strict\n  source: user\n'), text);
  assert.ok(
    text.includes(
      `\nwarning: user:flows.strict: Flow user:strict names command "lint", which ${REPOSITORY_FILE} does not ` +
        'declare, so it cannot run in this repository [undeclared-command]\n',
    ),
    text,
  );
});

// Only a command named by a string fits one repository and not another: a malformed one is an error everywhere.
test("gg doctor reports a user Check whose command is not a name as an error, not as the Flow's fit", async () => {
  const user = { ...example(), ...MACHINE_SETTINGS };
  delete user.commands;
  delete user.testPaths;
  delete user.labelPrefix;
  delete user.baseBranch;
  user.flows = { strict: user.flows.default };
  user.procedures['base-check'].actions[0].command = ['test'];
  const { text, exitCode } = await doctor.doctor({ config: sources(example(), user), ...DEPS });
  assert.equal(exitCode, 1, text);
  assert.ok(
    text.includes(
      '\nerror: user:procedures.base-check.actions[0]: Check test names command ["test"], which the repository ' +
        'does not declare [undeclared-command]\n',
    ),
    text,
  );
});

// A record whose Flow is gone is kept for a human, so gg doctor says so before gg run does (A2).
test('gg doctor lists an Execution Record whose Flow is no longer declared as an error', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-doctor-records-');
  const gone = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 7,
    epic: null,
    flow: { name: 'gone', entry: 'red' },
    configHash: 'x',
    run: '20261016T000000Z-seed00',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/7-gone',
    base: 'main',
  });
  record.save(gone);
  record.save({ ...gone, ticket: 8, execution: 'ticket-8', flow: 'default' });
  const { text, exitCode } = await doctor.doctor({ config: sources(example()), ...DEPS, commonDir });
  assert.equal(exitCode, 1, text);
  assert.ok(
    text.includes(
      '\nerror: records.ticket-7: Execution Record ticket-7 runs Flow gone, which is no longer declared; declare it ' +
        'again to resume it, or run gg work abandon 7 to start over [unknown-flow]\n',
    ),
    text,
  );
  assert.ok(!text.includes('ticket-8'), text);
});

// gg doctor runs the Harness preflight gg run does, so a stub Harness fails both (#362, decision 1).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("gg doctor reports harness-preflight-failed for each Vertex on a stub Harness, as gg run's preflight does", async () => {
  const layer = example();
  for (const agent of Object.values<Record<string, unknown>>(layer.agents)) agent.harness = 'claude';
  const claude = await import('../../lib/harnesses/claude.ts');
  const { text, exitCode } = await doctor.doctor({ config: sources(layer), ...DEPS, harnesses: { claude } });
  assert.equal(exitCode, 1, text);
  const vertices = Object.entries(layer.flows.default.ticket.vertices)
    .filter(([, vertex]) => (vertex as { use?: string }).use !== undefined)
    .map(([id]) => id);
  assert.ok(vertices.length > 1, 'the example runs several Vertices on an Agent');
  assert.deepEqual(
    text.split('\n').filter((line) => line.startsWith('error: ')),
    vertices.map(
      (id) =>
        `error: flows.default.ticket.vertices.${id}: vertex ${id}: harness claude: not implemented ` +
        '[harness-preflight-failed]',
    ),
  );
});

// Each configuration gg run's preflight refuses, by what it breaks: none names --flow, which is gg run's own choice.
const REFUSED: [string, (repository: ReturnType<typeof runFixture.testConfig>) => void][] = [
  ['an undeclared command', (repository) => (repository.procedures.implement!.actions[1]!.command = 'lint')],
  ['no testPaths', (repository) => delete repository.testPaths],
  ['malformed commands', (repository) => (repository.commands = { Test: 'npm test', lint: '' })],
  ['malformed approvers', (repository) => (repository.approvers = 'some-login')],
  ['an unknown key', (repository) => ((repository.flows.default as { plan?: unknown }).plan = {})],
  ['an access outside the Permission Intents', (repository) => (repository.agents.implementer!.access = 'read-write')],
  ['an unset harness', (repository) => delete repository.agents.implementer!.harness],
  ['an unregistered harness', (repository) => (repository.agents.implementer!.harness = 'nope')],
  ['a stub harness', (repository) => (repository.agents.implementer!.harness = 'claude')],
  ['no State Database', () => undefined],
];

// V1: a configuration cannot pass one command and fail the other, so doctor prints each error gg run refuses with.
test("gg doctor gives every error gg run's preflight refuses with, line for line", async (t) => {
  const claude = await import('../../lib/harnesses/claude.ts');
  const harnesses = { fake: FAKE_HARNESS, claude };
  for (const [breaks, change] of REFUSED) {
    const commonDir =
      breaks === 'no State Database'
        ? tempDirectory.tempDirectory(t, 'gg-doctor-parity-')
        : tempDirectory.stateDatabaseDirectory(t, 'gg-doctor-parity-');
    const repository = runFixture.testConfig('');
    change(repository);
    const configuration = sources(repository);
    let refused: string[] = [];
    await run.admitConfiguration({ commonDir, config: configuration, harnesses }).catch((err: Error) => {
      refused = err.message.split('\n').filter((line) => line.startsWith('error: '));
    });
    assert.ok(refused.length, `gg run refuses ${breaks}`);
    const { text, exitCode } = await doctor.doctor({ config: configuration, ...DEPS, harnesses, commonDir });
    assert.deepEqual(
      text.split('\n').filter((line) => line.startsWith('error: ')),
      refused,
      breaks,
    );
    assert.equal(exitCode, 1, breaks);
  }
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
  const required = (name: string) =>
    (JSON.parse(exampleLayer.fixtureText(`${name}.schema.json`)) as { required: string[] }).required;
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
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: FAKE_HARNESS },
    gh,
    cwd: '/repo',
  });
  assert.equal(exitCode, 0, text);
  assert.ok(text.includes(`\n  approval labels: ${AWAIT_LABEL}, ${APPROVED_LABEL}, ${REJECTED_LABEL}\n`), text);
  assert.ok(text.includes('\n    approved -> end needs-human\n'), text);
  assert.ok(text.includes('\n    rejected -> end needs-replan\n'), text);
  assert.ok(!text.includes('missing from the repository'), text);
});

test('gg doctor reports the labels a Flow can request that the repository lacks', async () => {
  const gh = repository(AWAIT_LABEL);
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: FAKE_HARNESS },
    gh,
    cwd: '/repo',
  });
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
  fake.fail({ matches: (args) => args[0] === 'api', status: 502 });
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: FAKE_HARNESS },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.equal(exitCode, 0);
  assert.match(text, /\nwarning: could not read the repository's labels: .* \[repository-labels-unread\]\n/);
});

// gg run reads the owner/name on every Run, so doctor does too (#372).
test('gg doctor reads only the owner/name, and no labels, for a Flow that asks nobody', async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  await doctor.doctor({
    config: sources(example()),
    harnesses: { fake: FAKE_HARNESS },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.deepEqual(
    fake.calls.map((call) => [call.args.slice(0, 2), call.cwd]),
    [[['repo', 'view'], '/repo']],
  );
});

// Each way gh can fail to give an owner/name, as gh's own transport would answer `gh repo view`.
const UNREAD: [string, () => Promise<string>][] = [
  ['gh exits nonzero', () => Promise.reject(new Error('gh repo view --json nameWithOwner exited 1\nno git remotes'))],
  ['gh answers no JSON', () => Promise.resolve('not json')],
  ['gh answers no nameWithOwner', () => Promise.resolve('{}')],
  ['gh answers a name with no owner', () => Promise.resolve('{"nameWithOwner":"r"}')],
  ['gh answers a dot-dot owner', () => Promise.resolve('{"nameWithOwner":"../r"}')],
];

// #372 (owner D1 A): doctor never passes a repository whose owner/name gg run refuses before its first Ticket read.
test("gg doctor gives gg run's repository-unread error for each way gh fails to give the owner/name", async (t) => {
  for (const [fails, answer] of UNREAD) {
    const fixture = runFixture.fixture(t);
    fixture.options.deps.gh = github.createGh(async (args) => {
      if (args[0] === 'repo') return answer();
      throw new Error(`gh ${args.join(' ')}: not expected`);
    });
    let refused: string[] = [];
    await run.runTarget(fixture.options).catch((err: Error) => {
      refused = err.message.split('\n').filter((line) => line.startsWith('error: '));
    });
    assert.equal(refused.length, 1, `gg run refuses when ${fails}`);
    assert.ok(refused[0]!.endsWith(' [repository-unread]'), refused[0]);
    const { text, exitCode } = await doctor.doctor({
      config: fixture.options.config,
      harnesses: fixture.options.harnesses,
      gh: fixture.options.deps.gh,
      cwd: fixture.mainRoot,
      commonDir: fixture.commonDir,
    });
    assert.deepEqual(
      text.split('\n').filter((line) => line.startsWith('error: ')),
      refused,
      fails,
    );
    assert.equal(exitCode, 1, fails);
  }
});

// Owner D3 A: the label read fails for the same cause, so one cause gives one finding.
test('gg doctor reads no labels when it cannot read the owner/name', async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  fake.fail({ matches: (args) => args[0] === 'repo', stderr: 'no git remotes found' });
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: FAKE_HARNESS },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.equal(exitCode, 1, text);
  assert.deepEqual(
    fake.calls.map((call) => call.args.slice(0, 2)),
    [['repo', 'view']],
  );
  assert.match(
    text,
    /\nerror: cannot read the GitHub owner\/name of \/repo: no git remotes found .*\[repository-unread\]\n/,
  );
  assert.ok(!text.includes('[repository-labels-'), text);
  assert.ok(text.endsWith('\n1 error, 3 warnings\n'), text);
});

// Owner D5 B: doctor reads the owner/name beside the configuration's own errors, which gg run reports first.
test('gg doctor reports an unreadable owner/name beside the configuration errors', async () => {
  const config = example();
  delete config.testPaths;
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  fake.fail({ matches: (args) => args[0] === 'repo', stderr: 'no git remotes found' });
  const { text, exitCode } = await doctor.doctor({
    config: sources(config),
    harnesses: { fake: FAKE_HARNESS },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.equal(exitCode, 1, text);
  assert.match(text, /\nerror: .*\[required-key-missing\]\n/);
  assert.match(text, /\nerror: cannot read the GitHub owner\/name of \/repo: .*\[repository-unread\]\n/);
});

test('gg doctor prints a Flow named entirely with Object.prototype names like one with ordinary names', async () => {
  const print = (names: namedFlow.Names) =>
    doctor.doctor({
      config: sources({ ...namedFlow.namedConfig(names), labelPrefix: 'gg', baseBranch: 'main' } as config.Source),
      ...DEPS,
    });
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
  const { text, exitCode } = await doctor.doctor({ config: sources(config), ...DEPS });
  const one = exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n');
  const flowSection = one.slice(0, one.indexOf('\nwarning: ') + 1);
  assert.equal(text, one.replace(flowSection, flowSection + flowSection.replace('flow default\n', 'flow light\n')));
  assert.equal(exitCode, 0);
});

// The keys a summary line shows a value of the wrong type at: a Vertex's access (its Agent's), a Check's kind, a
// requires item, a Flow route's end, a table row's Outcome, condition and comparison, and the labelPrefix.
const SHOWN_KEYS = [
  ['agents', 'implementer', 'access'],
  ['procedures', 'base-check', 'actions', 0, 'kind'],
  ['procedures', 'implement', 'claimTokens', 'ok', 'requires', 0],
  ['flows', 'default', 'ticket', 'routes', 'misscoped', 'end'],
  ['procedures', 'review', 'passed', 0, 'outcome'],
  ['procedures', 'review', 'passed', 1, 'when', 'check.repeat'],
  ['procedures', 'review', 'passed', 3, 'when', 'response.count', '>'],
  ['labelPrefix'],
];
type KeyPath = (string | number)[];

// The example with the summary sites it lacks: a Vertex that asks a human, and a comparison in a table row. No field
// of the example's schemas is a number, so the comparison's field is undefined, an error doctor reports beside the
// summary.
function summaryLayer() {
  const layer = asking();
  layer.procedures.review.passed.push({ when: { 'response.count': { '>': 0 } }, outcome: 'retest' });
  return layer;
}

// Puts `value` at `path` in `layer`.
function setValue(layer: exampleLayer.Layer, path: KeyPath, value: unknown) {
  const parent = path.slice(0, -1).reduce((node, key) => node[key], layer);
  parent[path.at(-1)!] = value;
}

// The summary layer with `value` at `path`.
function withValue(path: KeyPath, value: unknown) {
  const layer = summaryLayer();
  setValue(layer, path, value);
  return layer;
}

// A value that is not a string shows as JSON, where String() would print [object Object] or a blank (#305).
for (const shown of ['{}', '[]']) {
  test(`gg doctor shows ${shown} where a key holds it in place of a string`, async () => {
    const layer = summaryLayer();
    for (const path of SHOWN_KEYS) setValue(layer, path, JSON.parse(shown));
    const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
    for (const line of [
      `\nvertex red\n  procedure: tests-fail\n  agent: implementer (harness fake)\n  access: ${shown}\n`,
      `\n  checks: test (${shown} test)\n`,
      `\n  claimTokens: ok requires ${shown}, blocked stops\n`,
      `\n  routes: misscoped -> end ${shown}, * -> end needs-human\n`,
      `\n    1. claim = ok and check.review-pass = passed -> ${shown}\n`,
      `\n    2. check.repeat = ${shown} -> repeat\n`,
      `\n    4. response.count > ${shown} -> retest\n`,
      `\n  approval labels: ${['await:approve', 'decide:approve:approved', 'decide:approve:rejected']
        .map((label) => `${shown}:${label}`)
        .join(', ')}\n`,
    ])
      assert.ok(text.includes(line), `${line}\n---\n${text}`);
  });
}

// JSON.parse reads a number past the largest double, such as 1e999, as Infinity, which JSON would spell null.
test('gg doctor shows a number too large for a double as Infinity, not null', async () => {
  const layer = withValue(['flows', 'default', 'actionCap'], JSON.parse('1e999'));
  const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
  assert.ok(text.includes('\n  actionCap: Infinity\n'), text);
});

test("gg doctor says a null item in an input's from is no source", async () => {
  const layer = withValue(
    ['flows', 'default', 'ticket', 'vertices', 'implementer-fix', 'inputs', 'previous', 'from', 0],
    null,
  );
  const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
  assert.ok(text.includes('\n    previous <- no source | senior-red.rescue (optional)\n'), text);
});

// Every key of a Layer, an object's keys and a list's indexes.
function keyPaths(value: unknown, path: KeyPath = []): KeyPath[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...path, Array.isArray(value) ? Number(key) : key];
    return [childPath, ...keyPaths(child, childPath)];
  });
}
// The summary layer's keys, not the files loaded beside it.
const SUMMARY_KEYS = keyPaths(summaryLayer()).filter((path) => path[0] !== 'files');

// A summary line that shows a value as String() does: [object Object], or a blank where a value belongs, which leaves
// trailing or doubled whitespace, a space inside parentheses or before a separator, or a label with no prefix.
const UNCLEAR_VALUE = /\[object Object\]|\s$|\S {2}|\( | \)| [,;:]/;

// The summary lines, not the error and warning lines, that show a value unclearly with `value` at `path`.
async function unclearLines(path: KeyPath, value: unknown) {
  const { text } = await doctor.doctor({ config: sources(withValue(path, value)), ...DEPS });
  return text
    .split('\n')
    .filter((line) => !/^(error|warning): /.test(line) && UNCLEAR_VALUE.test(line))
    .map((line) => `${path.join('.')}: ${line}`);
}

test("the example's doctor.txt shows no value unclearly", () => {
  const lines = exampleLayer.fixtureText('doctor.txt').replaceAll('\r\n', '\n').split('\n');
  assert.deepEqual(
    lines.filter((line) => !/^(error|warning): /.test(line) && UNCLEAR_VALUE.test(line)),
    [],
  );
  assert.ok(SUMMARY_KEYS.length > 500, `${SUMMARY_KEYS.length} keys`);
});

// Each key of the summary layer in turn, swapped for {}, for [], and each list item for null (#305).
for (const [name, value, paths] of [
  ['{}', {}, SUMMARY_KEYS],
  ['[]', [], SUMMARY_KEYS],
  ['null', null, SUMMARY_KEYS.filter((path) => typeof path.at(-1) === 'number')],
] as const) {
  const keys = name === 'null' ? 'list item' : 'key';
  test(`no summary line shows [object Object] or a blank when any ${keys} of the example holds ${name}`, async () => {
    const unclear: string[] = [];
    for (const path of paths) unclear.push(...(await unclearLines(path, value)));
    assert.deepEqual(unclear, []);
  });
}
