import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as config from '../../lib/config.ts';
import * as configurationCheck from '../../lib/configuration-check.ts';
import * as report from '../../lib/validate/report.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import type * as golden from '../support/golden.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as seededRecords from '../support/seeded-records.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const REPOSITORY_FILE = '/repo/.agents/gg/gg.json';
const USER_FILE = '/home/.agents/gg/gg.json';
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };
const HARNESSES = { fake: fakeHarness.fakeHarness() };

// The run fixture's repository source (a red, green and publish Flow on the fake Harness, unless `fullFlow`), which a
// case changes before it checks.
const repositorySource = (options: { fullFlow?: boolean } = {}) => runFixture.testConfig('', options);

// `repository` as the repository's source, beside a user source that holds only the machine settings, or `user`.
const sources = (
  repository: config.Source,
  user: config.Source = { ...MACHINE_SETTINGS, files: {} },
): config.Configuration => ({ repository, user, repositoryFile: REPOSITORY_FILE, userFile: USER_FILE });

const checked = (
  configuration: config.Configuration,
  { harnesses = {}, commonDir }: { harnesses?: Record<string, unknown>; commonDir?: string } = {},
) => configurationCheck.check({ config: configuration, harnesses: { ...HARNESSES, ...harnesses }, commonDir });

// The verdict's errors as gg prints them, the configuration's before the environment's.
const errorLines = (verdict: configurationCheck.Verdict) =>
  [...verdict.configurationErrors, ...verdict.environmentErrors].map((problem) => report.line('error', problem));

test('an error line ends in its code', async () => {
  const repository = repositorySource();
  repository.procedures.implement!.actions[1]!.command = 'lint';
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    'error: procedures.implement.actions[1]: Check test names command "lint", ' +
      'which the repository does not declare [undeclared-command]',
  ]);
});

test('preflight rejects a repository without testPaths', async () => {
  const repository = repositorySource();
  delete repository.testPaths;
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    `error: testPaths: ${REPOSITORY_FILE} declares no testPaths; merge {"testPaths":["<glob>"]} into it ` +
      '[required-key-missing]',
  ]);
});

// gg ships no Flow, so a repository that declares none, beside a user's directory that declares none, fails preflight
// naming gg init (P1a).
test('preflight without a Flow names gg init', async () => {
  const contract = { commands: { test: 'npm test' }, testPaths: ['test/**'], labelPrefix: 'gg', baseBranch: 'main' };
  assert.deepEqual(errorLines(await checked(sources({ ...contract, files: {} }))), [
    "error: flows: no Flow is declared; run gg init to write the example Flow into the repository's .agents/gg/ " +
      '[no-flow-declared]',
  ]);
});

// The fixture Flow's green Vertex, whose inputs a case adds to.
const greenInputs = (repository: ReturnType<typeof repositorySource>) =>
  repository.flows.default!.ticket.vertices.green!.inputs as Record<string, unknown>;

test('gg run rejects a required input that a route may not produce', async () => {
  const repository = repositorySource();
  greenInputs(repository).previous = { from: 'green.commit.files' };
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    'error: flows.default.ticket.vertices.green.inputs.previous: input previous is required, but some route to ' +
      'green may not produce any of its sources; admission checks routes, not runs, so if every run does produce ' +
      'one, mark the input optional [required-input-unsure]',
  ]);
});

test('gg run rejects pick over a value that is not a list of objects', async () => {
  const repository = repositorySource();
  greenInputs(repository).names = { from: 'red.commit.files', pick: 'name' };
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    'error: flows.default.ticket.vertices.green.inputs.names: pick needs a list of objects; "red.commit.files" is ' +
      '{"kind":"list","of":{"kind":"string"}} [not-a-list-of-objects]',
  ]);
});

test('approvers reach the reader, and a malformed list fails preflight', async () => {
  const repository = repositorySource();
  repository.approvers = 'some-login';
  const lines = errorLines(await checked(sources(repository)));
  assert.ok(
    lines.some((line) => /approvers must be a list of GitHub logins/.test(line)),
    lines.join('\n'),
  );
});

test('preflight names a Harness that fails in a Flow --flow does not name', async () => {
  const repository = repositorySource();
  const other = repositorySource().flows.default as golden.ConfiguredFlow;
  repository.agents.other = { ...repository.agents.implementer, harness: 'claude' };
  (other.ticket.vertices.red as { use: string }).use = 'other';
  repository.flows.other = other;
  const claude = await import('../../lib/harnesses/claude.ts');
  assert.deepEqual(errorLines(await checked(sources(repository), { harnesses: { claude } })), [
    'error: flows.other.ticket.vertices.red: vertex red: harness claude: not implemented [harness-preflight-failed]',
  ]);
});

// A lost gg.db leaves gg/ behind, so the check is on the file: preflight and gg doctor both report it this way (#150).
test('a gg.db deleted from an existing gg directory is a missing State Database', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-configuration-check-');
  rmSync(join(commonDir, 'gg', 'gg.db'));
  const verdict = await checked(sources(repositorySource()), { commonDir });
  assert.deepEqual(
    verdict.environmentErrors.map(({ code, message, params }) => ({ code, message, params })),
    [
      {
        code: 'state-database-missing',
        message: `no State Database at ${join(commonDir, 'gg', 'gg.db')}: run gg init`,
        params: { path: join(commonDir, 'gg', 'gg.db') },
      },
    ],
  );
});

test('preflight lists every malformed Declared Command and a missing test, naming the repository Layer', async () => {
  const repository = repositorySource();
  repository.commands = { Test: 'npm test', lint: '' };
  const file = REPOSITORY_FILE;
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    `error: commands: ${file}: command name "Test" must match [a-z][a-z0-9-]* [invalid-name]`,
    `error: commands.lint: ${file}: command lint must be a non-empty single-line string [invalid-command-line]`,
    `error: commands: ${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it ` +
      '[required-key-missing]',
    'error: procedures.tests-fail.actions[1]: Check red-check names command "test", ' +
      'which the repository does not declare [undeclared-command]',
    'error: procedures.implement.actions[1]: Check test names command "test", ' +
      'which the repository does not declare [undeclared-command]',
    'error: procedures.fix.actions[1]: Check test names command "test", ' +
      'which the repository does not declare [undeclared-command]',
    'error: procedures.publish.actions[0]: Check test names command "test", ' +
      'which the repository does not declare [undeclared-command]',
  ]);
});

// A Flow has no plan key (#298): a planning Flow is a Flow run at Epic level, request slice 7's design, so admission
// rejects the key as gg doctor does.
test('a Flow with a plan key fails admission before any effect', async () => {
  const repository = repositorySource();
  (repository.flows.default as { plan?: unknown }).plan = { entry: 'planner', vertices: {} };
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    'error: flows.default: unknown key "plan" [unknown-key]',
  ]);
});

test("an Agent's access outside the Permission Intents fails admission before any effect", async () => {
  const repository = repositorySource();
  repository.agents.implementer!.access = 'read-write';
  assert.deepEqual(errorLines(await checked(sources(repository))), [
    'error: agents.implementer.access: access "read-write" is not a Permission Intent: read-only or ' +
      'workspace-write [unknown-permission-intent]',
  ]);
});

// gg run puts the errors of its --flow choice between the two groups, so its preflight reads in today's order (#362).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("the configuration's errors and the environment's come in two groups, the State Database's before the Harnesses'", async (t) => {
  const commonDir = tempDirectory.tempDirectory(t, 'gg-configuration-check-');
  const repository = repositorySource();
  delete repository.testPaths;
  repository.agents.implementer!.harness = 'claude';
  const claude = await import('../../lib/harnesses/claude.ts');
  const verdict = await checked(sources(repository), { harnesses: { claude }, commonDir });
  const codes = (problems: report.Problem[]) => problems.map((problem) => `${problem.at} ${problem.code}`);
  assert.deepEqual(codes(verdict.configurationErrors), ['testPaths required-key-missing']);
  assert.deepEqual(codes(verdict.environmentErrors), [
    ' state-database-missing',
    'flows.default.ticket.vertices.red harness-preflight-failed',
    'flows.default.ticket.vertices.green harness-preflight-failed',
  ]);
});

// A user Flow that names a command the repository does not declare is a misfit: gg doctor warns of it, gg run refuses
// it only when selected (Q21), and Harness preflight leaves it out, as gg run admits it nowhere.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a user Flow that does not fit the repository is a misfit, kept out of the errors and of Harness preflight', async () => {
  const repository = repositorySource();
  const user = { ...structuredClone(repositorySource()), ...MACHINE_SETTINGS } as config.Source & typeof repository;
  for (const key of ['commands', 'testPaths', 'labelPrefix', 'baseBranch']) delete user[key];
  user.flows = { strict: user.flows.default! };
  user.procedures.publish!.actions[0]!.command = 'lint';
  user.agents.implementer!.harness = 'claude';
  const claude = await import('../../lib/harnesses/claude.ts');
  const verdict = await checked(sources(repository, user), { harnesses: { claude } });
  assert.deepEqual(errorLines(verdict), []);
  assert.deepEqual([...verdict.flows.keys()], ['default', 'user:strict']);
  assert.deepEqual(
    [...verdict.misfits].map(([name, problem]) => `${name} ${report.line('warning', problem)}`),
    [
      'user:strict warning: user:flows.strict: Flow user:strict names command "lint", which ' +
        `${REPOSITORY_FILE} does not declare, so it cannot run in this repository [undeclared-command]`,
    ],
  );
});

// A record gg run would resume whose Flow is gone is kept for a person (A2): gg doctor lists it as an error, and gg run
// reports it for that Ticket alone, so the check gives it apart from the errors (#362). A record pinned to a misfit
// counts as gone, since gg run admits no misfit.
test('an Execution Record a Run would resume whose Flow is gone is a gone-Flow record, not an error', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-configuration-check-');
  const repository = repositorySource();
  const user = { ...structuredClone(repositorySource()), ...MACHINE_SETTINGS } as config.Source & typeof repository;
  for (const key of ['commands', 'testPaths', 'labelPrefix', 'baseBranch']) delete user[key];
  user.flows = { strict: user.flows.default! };
  user.procedures.publish!.actions[0]!.command = 'lint';
  const expected: string[] = [];
  seededRecords.SHAPES.forEach((shape, index) => {
    const ticket = index + 1;
    seededRecords.seed(commonDir, ticket, 'gone', shape);
    if (shape.resumption === 'resume') expected.push(`records.ticket-${ticket}`);
  });
  const declared = seededRecords.seed(commonDir, 50, 'default', seededRecords.SHAPES[0]!);
  seededRecords.seed(commonDir, 51, 'user:strict', seededRecords.SHAPES[0]!);
  expected.push('records.ticket-51');
  const verdict = await checked(sources(repository, user), { commonDir });
  assert.deepEqual(errorLines(verdict), []);
  assert.deepEqual(
    verdict.goneFlowRecords().map((problem) => problem.at),
    expected,
  );
  assert.ok(!verdict.goneFlowRecords().some((problem) => problem.at === `records.${declared.execution}`));
  assert.equal(
    report.line('error', verdict.goneFlowRecords()[0]!),
    'error: records.ticket-1: Execution Record ticket-1 runs Flow gone, which is no longer declared; declare it ' +
      'again to resume it, or run gg work abandon 1 to start over [unknown-flow]',
  );
});

test('the verdict carries the Settings only when the settings hold no error', async () => {
  const valid = await checked(sources(repositorySource()));
  assert.deepEqual(valid.settings, {
    labelPrefix: 'gg',
    baseBranch: 'main',
    worktreeRoot: '~/worktrees',
    maxParallel: 2,
    commands: { test: 'npm test' },
    testPaths: runFixture.testConfig('').testPaths,
  });
  const repository = repositorySource();
  delete repository.testPaths;
  assert.equal((await checked(sources(repository))).settings, undefined);
});

// Decision 4 of #362: nothing in these modules is exported for the tests alone. A module's export counts as called when
// a production file that imports the module names it after a dot, as a namespace import does.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const productionFiles = () =>
  ['lib', 'bin', 'scripts'].flatMap((directory) =>
    readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(directory, name).replaceAll('\\', '/')),
  );
const exportsOf = (text: string) =>
  [...text.matchAll(/^export (?:async )?(?:function|const|interface|type|class) (\w+)/gm)].map((match) => match[1]!);

function exportsWithoutCaller(module: string, files: Record<string, string>): string[] {
  const base = module.split('/').at(-1)!;
  const importers = Object.entries(files).filter(
    ([name, text]) => name !== module && new RegExp(`from '[./]*(?:[\\w-]+/)*${base.replace('.', '\\.')}'`).test(text),
  );
  return exportsOf(files[module]!).filter(
    (name) => !importers.some(([, text]) => new RegExp(`\\.${name}\\b`).test(text)),
  );
}

test('every export of lib/settings.ts and lib/configuration-check.ts has a caller outside the tests', () => {
  const files = Object.fromEntries(productionFiles().map((name) => [name, readFileSync(join(ROOT, name), 'utf8')]));
  // The rule is not vacuous: an export nothing but a test calls is found.
  const sample = { ...files, 'lib/settings.ts': `${files['lib/settings.ts']}\nexport const onlyForTests = 1;\n` };
  assert.ok(exportsWithoutCaller('lib/settings.ts', sample).includes('onlyForTests'));
  assert.deepEqual(
    ['lib/settings.ts', 'lib/configuration-check.ts'].flatMap((module) =>
      exportsWithoutCaller(module, files).map((name) => `${module} ${name}`),
    ),
    [],
  );
});
