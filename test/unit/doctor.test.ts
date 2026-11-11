import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as record from '../../lib/record.ts';
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
  config.agents.spare = { harness: 'fake' };
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

test('gg doctor reads schemas from the loaded Layer files', async () => {
  const config = example();
  const schema = JSON.parse(config.files['review.schema.json'].bytes);
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

// A repository and a user directory for `gg init`, neither holding a gg.json yet.
function initRoots(t: TestContext) {
  const directory = tempDirectory.tempDirectory(t, 'gg-init-');
  return { repo: join(directory, 'repo'), user: join(directory, 'user') };
}
const repositoryDirectory = (root: string) => join(root, '.agents', 'gg');
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// gg doctor over a repository and user directory as gg reads them, with the Harnesses gg ships.
async function doctorOver(repo: string, user: string) {
  return doctor.doctor({
    config: config.loadSources(repo, user),
    harnesses: shipped.HARNESSES,
    gh: DEPS.gh,
    cwd: repo,
  });
}

// Adds the test command the example leaves out, which only the repository can say.
function declareTest(repo: string) {
  const file = join(repositoryDirectory(repo), 'gg.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  written.commands.test = 'npm test';
  writeFileSync(file, JSON.stringify(written));
}

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("gg init writes the example with the repository's keys, creates the user's gg.json, and gg doctor accepts both", async (t) => {
  const { repo, user } = initRoots(t);
  const text = doctor.init(repo, { baseBranch: 'trunk', userDirectory: user });
  const written = repositoryDirectory(repo);
  assert.deepEqual(readdirSync(written).sort(), [...exampleLayer.WRITTEN_NAMES].sort(), 'every file but doctor.txt');
  for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
    assert.equal(readFileSync(join(written, name), 'utf8'), exampleLayer.fixtureText(name), name);
  const expected = JSON.parse(exampleLayer.fixtureText('gg.json'));
  delete expected.commands.test;
  expected.baseBranch = 'trunk';
  assert.deepEqual(
    JSON.parse(readFileSync(join(written, 'gg.json'), 'utf8')),
    expected,
    "the fixture's gg.json with commands.test removed and the repository's default branch",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(user, 'gg.json'), 'utf8')), MACHINE_SETTINGS);
  // The advice gg init gives the person who runs it (L9, J11).
  assert.match(text, /read-only default workflow permissions/);
  assert.match(text, /assumes the test command is deterministic/);

  declareTest(repo);
  const accepted = await doctorOver(repo, user);
  assert.equal(accepted.exitCode, 0, accepted.text);
  assert.match(accepted.text, /\n0 errors, 2 warnings\n$/);
});

test('gg init keeps an existing user gg.json', (t) => {
  const { repo, user } = initRoots(t);
  mkdirSync(user, { recursive: true });
  const kept = '{ "maxParallel": 5, "worktreeRoot": "D:/wt" }\n';
  writeFileSync(join(user, 'gg.json'), kept);
  doctor.init(repo, { baseBranch: 'main', userDirectory: user });
  assert.equal(readFileSync(join(user, 'gg.json'), 'utf8'), kept);
});

// Each Agent of the example, its Persona and access, with the harness, model and effort examples/<harness>.json names.
const HARNESS_AGENTS = {
  claude: {
    implementer: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'claude',
      model: 'opus',
      effort: 'high',
    },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'claude', model: 'sonnet', effort: 'high' },
    senior: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude', model: 'opus', effort: 'max' },
  },
  codex: {
    implementer: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
    },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    senior: {
      persona: 'implementer.md',
      access: 'workspace-write',
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    },
  },
};

for (const [harness, expected] of Object.entries(HARNESS_AGENTS)) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`gg init --harness ${harness} writes each Agent's harness, model and effort, and gg doctor accepts them`, async (t) => {
    const { repo, user } = initRoots(t);
    doctor.init(repo, { baseBranch: 'main', userDirectory: user, harness });
    const { agents } = JSON.parse(readFileSync(join(repositoryDirectory(repo), 'gg.json'), 'utf8'));
    assert.deepEqual(agents, expected);
    declareTest(repo);
    const accepted = await doctorOver(repo, user);
    assert.equal(accepted.exitCode, 0, accepted.text);
  });
}

// --harness takes a name, never a path, and writes nothing when it names no Harness examples/ holds.
test('gg init --harness with a name examples/ does not hold fails, writing nothing', (t) => {
  const { repo, user } = initRoots(t);
  assert.throws(() => doctor.init(repo, { baseBranch: 'main', userDirectory: user, harness: '../package' }), {
    message: 'no Harness named ../package has example settings; gg init --harness takes claude or codex',
  });
  assert.equal(existsSync(repo), false, 'no repository file');
  assert.equal(existsSync(user), false, "no user's gg.json");
});

test('gg init keeps an existing repository configuration, says so and exits successfully', (t) => {
  // It returns what it says, and throws only on a failed write, so gg exits 0 (test/e2e/gg.test.ts).
  const { repo, user } = initRoots(t);
  mkdirSync(repositoryDirectory(repo), { recursive: true });
  const file = join(repositoryDirectory(repo), 'gg.json');
  const kept = '{ "commands": { "test": "make test" } }\n';
  writeFileSync(file, kept);
  assert.ok(
    doctor
      .init(repo, { baseBranch: 'main', userDirectory: user })
      .startsWith(`gg init kept the existing configuration and wrote none of the example: ${file} exists.\n`),
  );
  assert.deepEqual(readdirSync(repositoryDirectory(repo)), ['gg.json']);
  assert.equal(readFileSync(file, 'utf8'), kept);
});

test('gg init writes nothing over any file it would write', (t) => {
  const { repo, user } = initRoots(t);
  mkdirSync(repositoryDirectory(repo), { recursive: true });
  const red = join(repositoryDirectory(repo), 'red.md');
  writeFileSync(red, '# our own red Brief\n');
  assert.ok(
    doctor
      .init(repo, { baseBranch: 'main', userDirectory: user })
      .startsWith(`gg init kept the existing configuration and wrote none of the example: ${red} exists.\n`),
  );
  assert.deepEqual(readdirSync(repositoryDirectory(repo)), ['red.md']);
});

// This repository's configuration was merged by hand from gg init's output (#120), so it runs on the example's own
// Flow.
test(
  "this repository's configuration is the example with its own commands and testPaths, " + 'and gg doctor accepts it',
  async (t) => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const own = JSON.parse(readFileSync(join(repositoryDirectory(repoRoot), 'gg.json'), 'utf8'));
    const example = JSON.parse(exampleLayer.fixtureText('gg.json'));
    assert.deepEqual(
      { ...own, commands: undefined, testPaths: undefined },
      { ...example, commands: undefined, testPaths: undefined },
    );
    for (const name of exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json'))
      assert.equal(
        readFileSync(join(repositoryDirectory(repoRoot), name), 'utf8'),
        exampleLayer.fixtureText(name),
        name,
      );
    const { user } = initRoots(t);
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'gg.json'), JSON.stringify(MACHINE_SETTINGS));
    const { text, exitCode } = await doctorOver(repoRoot, user);
    assert.equal(exitCode, 0, text);
    assert.match(text, /\n0 errors, 2 warnings\n$/);
  },
);

// The repository commits each Agent's harness, so gg init alone gives a Flow gg doctor accepts (ADR 0022).
test("the example's Agents name a harness", () => {
  const { agents } = JSON.parse(exampleLayer.fixtureText('gg.json'));
  assert.deepEqual(agents, {
    implementer: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude' },
    reviewer: { persona: 'reviewer.md', access: 'read-only', harness: 'claude' },
    senior: { persona: 'implementer.md', access: 'workspace-write', harness: 'claude' },
  });
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
  const commonDir = tempDirectory.tempDirectory(t, 'gg-doctor-records-');
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
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: {} },
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
    harnesses: { fake: {} },
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
  fake.fail({ matches: () => true, status: 502 });
  const { text, exitCode } = await doctor.doctor({
    config: sources(asking()),
    harnesses: { fake: {} },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.equal(exitCode, 0);
  assert.match(text, /\nwarning: could not read the repository's labels: .* \[repository-labels-unread\]\n/);
});

test('gg doctor reads no labels for a Flow that asks nobody', async () => {
  const fake = fakeGh.fakeGh({ branch: 'b', ticket: 1 });
  await doctor.doctor({
    config: sources(example()),
    harnesses: { fake: {} },
    gh: github.createGh(fake.gh),
    cwd: '/repo',
  });
  assert.deepEqual(fake.calls, []);
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
// requires item, a Flow route's end and a table row's Outcome.
const SHOWN_KEYS = [
  ['agents', 'implementer', 'access'],
  ['procedures', 'base-check', 'actions', 0, 'kind'],
  ['procedures', 'implement', 'claimTokens', 'ok', 'requires', 0],
  ['flows', 'default', 'ticket', 'routes', 'misscoped', 'end'],
  ['procedures', 'review', 'passed', 0, 'outcome'],
];
type KeyPath = (string | number)[];

// Puts `value` at `path` in `layer`.
function setValue(layer: exampleLayer.Layer, path: KeyPath, value: unknown) {
  const parent = path.slice(0, -1).reduce((node, key) => node[key], layer);
  parent[path.at(-1)!] = value;
}

// The example Layer with `value` at `path`.
function withValue(path: KeyPath, value: unknown) {
  const layer = example();
  setValue(layer, path, value);
  return layer;
}

// A value that is not a string shows as JSON, where String() would print [object Object] or a blank (#305).
for (const shown of ['{}', '[]']) {
  test(`gg doctor shows ${shown} where a key holds it in place of a string`, async () => {
    const layer = example();
    for (const path of SHOWN_KEYS) setValue(layer, path, JSON.parse(shown));
    const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
    for (const line of [
      `\nvertex red\n  procedure: tests-fail\n  agent: implementer (harness fake)\n  access: ${shown}\n`,
      `\n  checks: test (${shown} test)\n`,
      `\n  claimTokens: ok requires ${shown}, blocked stops\n`,
      `\n  routes: misscoped -> end ${shown}, * -> end needs-human\n`,
      `\n    1. claim = ok and check.review-pass = passed -> ${shown}\n`,
    ])
      assert.ok(text.includes(line), `${line}\n---\n${text}`);
  });
}

test("gg doctor says a null item in an input's from is no source", async () => {
  const layer = withValue(
    ['flows', 'default', 'ticket', 'vertices', 'implementer-fix', 'inputs', 'previous', 'from', 0],
    null,
  );
  const { text } = await doctor.doctor({ config: sources(layer), ...DEPS });
  assert.ok(text.includes('\n    previous <- no source | senior-red.rescue (optional)\n'), text);
});

// Every key of the example Layer, an object's keys and a list's indexes.
function keyPaths(value: unknown, path: KeyPath = []): KeyPath[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...path, Array.isArray(value) ? Number(key) : key];
    return [childPath, ...keyPaths(child, childPath)];
  });
}
const EXAMPLE_KEYS = keyPaths(exampleLayer.config());

// A summary line that shows a value as String() does: [object Object], or a blank where a value belongs, which leaves
// trailing or doubled whitespace, or a space inside parentheses or before a separator.
const UNCLEAR_VALUE = /\[object Object\]|\s$|\S {2}|\( | \)| [,;]/;

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
  assert.ok(EXAMPLE_KEYS.length > 500, `${EXAMPLE_KEYS.length} keys`);
});

// Each key of the example Layer in turn, swapped for {}, for [], and each list item for null (#305).
for (const [name, value, paths] of [
  ['{}', {}, EXAMPLE_KEYS],
  ['[]', [], EXAMPLE_KEYS],
  ['null', null, EXAMPLE_KEYS.filter((path) => typeof path.at(-1) === 'number')],
] as const) {
  const keys = name === 'null' ? 'list item' : 'key';
  test(`no summary line shows [object Object] or a blank when any ${keys} of the example holds ${name}`, async () => {
    const unclear: string[] = [];
    for (const path of paths) unclear.push(...(await unclearLines(path, value)));
    assert.deepEqual(unclear, []);
  });
}
