import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as config from '../../lib/config.ts';
import * as configurationCheck from '../../lib/configuration-check.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as procedureKinds from '../../lib/procedures.ts';
import * as report from '../../lib/validate/report.ts';
import * as corruptRecords from '../support/corrupt-records.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import type * as golden from '../support/golden.ts';
import * as recordedCli from '../support/recorded-cli.ts';
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

// `repository` as the repository's source, beside a user source that holds only the machine settings, or `user`; the
// files each names move beside it.
const sources = (
  { files: repositoryFiles = {}, ...repository }: config.Source & { files?: config.SourceFiles },
  { files: userFiles = {}, ...user }: config.Source & { files?: config.SourceFiles } = MACHINE_SETTINGS,
): config.Configuration => ({
  repository,
  user,
  repositoryFile: REPOSITORY_FILE,
  userFile: USER_FILE,
  files: { repository: repositoryFiles, user: userFiles },
});

const checkOf = (
  configuration: config.Configuration,
  { harnesses = {}, commonDir }: { harnesses?: Record<string, unknown>; commonDir?: string } = {},
) => configurationCheck.check({ config: configuration, harnesses: { ...HARNESSES, ...harnesses }, commonDir });

// The checked configuration's errors as gg prints them, the configuration's before the environment's.
const errorLines = (checked: configurationCheck.CheckedConfiguration) =>
  [...checked.configurationErrors, ...checked.environmentErrors].map((problem) => report.line('error', problem));

test('an error line ends in its code', async () => {
  const repository = repositorySource();
  repository.procedures.implement!.actions[1]!.command = 'lint';
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    'error: procedures.implement.actions[1]: Check test names command "lint", ' +
      'which the repository does not declare [undeclared-command]',
  ]);
});

test('preflight rejects a repository without testPaths', async () => {
  const repository = repositorySource();
  delete repository.testPaths;
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    `error: testPaths: ${REPOSITORY_FILE} declares no testPaths; merge {"testPaths":["<glob>"]} into it ` +
      '[required-key-missing]',
  ]);
});

// gg ships no Flow, so a repository that declares none, beside a user's directory that declares none, fails preflight
// naming gg init (P1a).
test('preflight without a Flow names gg init', async () => {
  const contract = { commands: { test: 'npm test' }, testPaths: ['test/**'], labelPrefix: 'gg', baseBranch: 'main' };
  assert.deepEqual(errorLines(await checkOf(sources({ ...contract, files: {} }))), [
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
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    'error: flows.default.ticket.vertices.green.inputs.previous: input previous is required, but some route to ' +
      'green may not produce any of its sources; admission checks routes, not runs, so if every run does produce ' +
      'one, mark the input optional [required-input-unsure]',
  ]);
});

test('gg run rejects pick over a value that is not a list of objects', async () => {
  const repository = repositorySource();
  greenInputs(repository).names = { from: 'red.commit.files', pick: 'name' };
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    'error: flows.default.ticket.vertices.green.inputs.names: pick needs a list of objects; "red.commit.files" is ' +
      '{"kind":"list","of":{"kind":"string"}} [not-a-list-of-objects]',
  ]);
});

test('approvers reach the reader, and a malformed list fails preflight', async () => {
  const repository = repositorySource();
  repository.approvers = 'some-login';
  const lines = errorLines(await checkOf(sources(repository)));
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
  const claude = fakeHarness.fakeHarness({
    resolveTools: () => {
      throw new Error('plugin gone is not installed');
    },
  });
  assert.deepEqual(errorLines(await checkOf(sources(repository), { harnesses: { claude } })), [
    'error: flows.other.ticket.vertices.red: vertex red: harness claude: plugin gone is not installed ' +
      '[harness-preflight-failed]',
  ]);
});

// The preflight stop for Claude is gone (#425, G7): the Claude Harness shipped builds passes preflight over a CLI
// logged in at the minimum version, whose cheap checks preflight runs (#427).
test('preflight admits the Claude Harness shipped builds over a logged-in CLI', async () => {
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude' });
  const { claude } = shipped.shipped(recordedCli.recordedCli());
  assert.deepEqual(errorLines(await checkOf(sources(repository), { harnesses: { claude } })), []);
});

// Q1 A: a failed check is one error for the Harness, at no configuration path, naming the check.
test('preflight fails a Flow whose Claude CLI is logged out', async () => {
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude' });
  const { claude } = shipped.shipped(recordedCli.recordedCli({ loggedOut: true }));
  const checked = await checkOf(sources(repository), { harnesses: { claude } });
  const failed = checked.environmentErrors.filter(
    (problem): problem is report.Problem<'harness-doctor-failed'> => problem.code === 'harness-doctor-failed',
  );
  assert.deepEqual(
    failed.map((problem) => ({ location: problem.at, harness: problem.params.harness, check: problem.params.check })),
    [{ location: '', harness: 'claude', check: 'login' }],
  );
  assert.deepEqual(
    errorLines(checked),
    failed.map((problem) => report.line('error', problem)),
  );
});

// G15: gg run preflight runs each used Harness's doctor in cheap mode, once whatever the number of its Vertices and
// Flows, and starts no Harness its Flows do not use.
test('preflight runs the cheap doctor of each Harness the Flows use, once, and of no other', async () => {
  const repository = repositorySource();
  const other = repositorySource().flows.default as golden.ConfiguredFlow;
  repository.agents.other = { ...repository.agents.implementer, harness: 'other' };
  (other.ticket.vertices.red as { use: string }).use = 'other';
  repository.flows.other = other;
  const doctored: [string, unknown][] = [];
  const recording = (name: string) => ({
    ...fakeHarness.fakeHarness({ name }),
    doctor: (options: unknown) => {
      doctored.push([name, options]);
      return Promise.resolve({ ok: true, checks: [] });
    },
  });
  const harnesses = Object.fromEntries(['fake', 'other', 'unused'].map((name) => [name, recording(name)]));
  await checkOf(sources(repository), { harnesses });
  // The Harnesses the Flows' Agents use, read from the configuration.
  const agents = new Map(Object.entries(repository.agents));
  const used = new Set(
    Object.values(repository.flows as Record<string, golden.ConfiguredFlow>).flatMap((flow) =>
      Object.values(flow.ticket.vertices).flatMap(({ use }) =>
        typeof use === 'string' ? [String(agents.get(use)?.harness)] : [],
      ),
    ),
  );
  assert.ok(used.size > 1 && used.size < Object.keys(harnesses).length, 'two Harnesses used, one not');
  assert.deepEqual(
    doctored.toSorted(([left], [right]) => left.localeCompare(right)),
    [...used].sort().map((name) => [name, { probe: false }]),
  );
});

// The agent Action copies what resolveTools returns at once, so preflight refuses an answer it could not copy (#411).
test('preflight refuses a Harness whose resolveTools answers with a Promise', async () => {
  const fake = fakeHarness.fakeHarness({ resolveTools: async () => ({ allowed: ['Read'] }) });
  assert.deepEqual(errorLines(await checkOf(sources(repositorySource()), { harnesses: { fake } })), [
    'error: flows.default.ticket.vertices.red: vertex red: harness fake: resolveTools: the value is a Promise, ' +
      'which JSON cannot hold [harness-preflight-failed]',
    'error: flows.default.ticket.vertices.green: vertex green: harness fake: resolveTools: the value is a Promise, ' +
      'which JSON cannot hold [harness-preflight-failed]',
  ]);
});

test('a Promise resolveTools rejects is refused as a Promise, and its rejection does not end gg', async () => {
  const fake = fakeHarness.fakeHarness({ resolveTools: () => Promise.reject(new Error('bad tools')) });
  assert.deepEqual(errorLines(await checkOf(sources(repositorySource()), { harnesses: { fake } })), [
    'error: flows.default.ticket.vertices.red: vertex red: harness fake: resolveTools: the value is a Promise, ' +
      'which JSON cannot hold [harness-preflight-failed]',
    'error: flows.default.ticket.vertices.green: vertex green: harness fake: resolveTools: the value is a Promise, ' +
      'which JSON cannot hold [harness-preflight-failed]',
  ]);
});

// The Claude Harness allows the Declared Commands, so preflight resolves each Agent's tools with the repository's
// (#422, decision 6).
test("preflight resolves each Agent's tools with the repository's Declared Commands and the platform", async () => {
  const contexts: unknown[] = [];
  const fake = fakeHarness.fakeHarness({
    resolveTools: (_agent, context) => {
      contexts.push(context);
      return {};
    },
  });
  await checkOf(sources(repositorySource()), { harnesses: { fake } });
  assert.deepEqual(contexts, [
    { commands: { test: 'npm test' }, platform: process.platform },
    { commands: { test: 'npm test' }, platform: process.platform },
  ]);
});

// A Setting's error elsewhere leaves the Declared Commands valid, so the Harnesses still resolve with them (#424, D5).
test("preflight keeps the repository's valid Declared Commands when another setting is invalid", async () => {
  const contexts: unknown[] = [];
  const fake = fakeHarness.fakeHarness({
    resolveTools: (_agent, context) => {
      contexts.push(context);
      return {};
    },
  });
  await checkOf(sources(repositorySource(), { ...MACHINE_SETTINGS, maxParallel: 0, files: {} }), {
    harnesses: { fake },
  });
  assert.deepEqual(contexts, [
    { commands: { test: 'npm test' }, platform: process.platform },
    { commands: { test: 'npm test' }, platform: process.platform },
  ]);
});

// A field the Claude Harness declares unsupported is the validator's one error at the key, which gg doctor and gg run
// preflight both report; no Vertex's Harness preflight repeats it (Q2 A of #429).
test('a Claude Agent listing mcp is one unsupported-agent-field error, which no Vertex preflight repeats', async () => {
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude', mcp: ['github'] });
  const claude = await import('../../lib/harnesses/claude.ts');
  const checked = await checkOf(sources(repository), { harnesses: { claude } });
  assert.deepEqual(
    checked.configurationErrors.map((problem) => `${problem.at} ${problem.code}`),
    ['agents.implementer.mcp unsupported-agent-field'],
  );
  const repeated = checked.environmentErrors.filter((problem) => /\bmcp\b/.test(problem.message));
  assert.deepEqual(repeated, []);
});

test("preflight fails a Claude Agent's plugin that is not installed on the Harness's resolveTools", async (t) => {
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude', plugins: ['gg-no-such-plugin'] });
  const claudeModule = await import('../../lib/harnesses/claude.ts');
  const claude = claudeModule.createClaude({ configDirectory: tempDirectory.tempDirectory(t, 'gg-claude-home-') });
  const lines = errorLines(await checkOf(sources(repository), { harnesses: { claude } }));
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(
    lines[0]!,
    /^error: flows\.default\.ticket\.vertices\.red: vertex red: harness claude: .*plugin gg-no-such-plugin/,
  );
  assert.match(
    lines[1]!,
    /^error: flows\.default\.ticket\.vertices\.green: vertex green: harness claude: .*plugin gg-no-such-plugin/,
  );
});

// A lost gg.db leaves gg/ behind, so the check is on the file: preflight and gg doctor both report it this way (#150).
test('a gg.db deleted from an existing gg directory is a missing State Database', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-configuration-check-');
  rmSync(join(commonDir, 'gg', 'gg.db'));
  const checked = await checkOf(sources(repositorySource()), { commonDir });
  assert.deepEqual(
    checked.environmentErrors.map(({ code, message, params }) => ({ code, message, params })),
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
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
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
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    'error: flows.default: unknown key "plan" [unknown-key]',
  ]);
});

test("an Agent's access outside the Permission Intents fails admission before any effect", async () => {
  const repository = repositorySource();
  repository.agents.implementer!.access = 'read-write';
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
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
  const checked = await checkOf(sources(repository), { harnesses: { claude }, commonDir });
  const codes = (problems: report.Problem[]) => problems.map((problem) => `${problem.at} ${problem.code}`);
  assert.deepEqual(codes(checked.configurationErrors), ['testPaths required-key-missing']);
  assert.deepEqual(codes(checked.environmentErrors), [
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
  const checked = await checkOf(sources(repository, user), { harnesses: { claude } });
  assert.deepEqual(errorLines(checked), []);
  assert.deepEqual([...checked.flows.keys()], ['default', 'user:strict']);
  assert.deepEqual(
    [...checked.misfits].map(([name, problem]) => `${name} ${report.line('warning', problem)}`),
    [
      'user:strict warning: user:flows.strict: Flow user:strict names command "lint", which ' +
        `${REPOSITORY_FILE} does not declare, so it cannot run in this repository [undeclared-command]`,
    ],
  );
});

type Repository = ReturnType<typeof repositorySource>;
type Flow = Repository['flows'][string];

// A user source: the run fixture's Procedures and Agents with the machine settings and no repository contract, whose
// Flows are `flows`, each a copy of the fixture's Flow that `change` may edit.
function userSource(flows: string[], change: (user: Repository, flow: Record<string, Flow>) => void = () => {}) {
  const user = { ...structuredClone(repositorySource()), ...MACHINE_SETTINGS } as Repository;
  for (const key of ['commands', 'testPaths', 'labelPrefix', 'baseBranch']) delete user[key];
  const fixtureFlow = user.flows.default!;
  user.flows = Object.fromEntries(flows.map((name) => [name, structuredClone(fixtureFlow)]));
  change(user, user.flows);
  return user;
}

// The Check kinds that name a Declared Command, each of which can name one the repository lacks.
const COMMAND_KINDS = Object.entries(procedureKinds.CHECK_KEYS)
  .filter(([, keys]) => keys.includes('command'))
  .map(([kind]) => kind);

// Procedure `misfit`: a copy of the first fixture Procedure with a Check of `kind`, whose Check names `command`, a
// command the repository does not declare when it is a string. Flow `strict`, when declared, runs it in place of the
// Procedure it copies.
function addMisfit(source: Repository, kind: string, command: unknown = 'lint') {
  const isKind = (action: Record<string, unknown>) => action.do === 'check' && action.kind === kind;
  const copied = Object.keys(source.procedures).find((name) => source.procedures[name]!.actions.some(isKind))!;
  const misfit = structuredClone(source.procedures[copied]!);
  misfit.actions.find(isKind)!.command = command;
  source.procedures.misfit = misfit;
  for (const vertex of Object.values(source.flows.strict?.ticket.vertices ?? {}))
    if (vertex.procedure === copied) vertex.procedure = 'misfit';
}

const loopCycle = 'the cycle through red, green has no edge or Vertex with max; the Action Cap does not bound a cycle';

// A misfit keeps out only the Flows that use it, so the user's other Flows pass every graph check before gg run admits
// them (H6), in gg doctor and preflight alike, which both read this check.
test("a user misfit does not skip the graph checks of the user's other Flows", async () => {
  const user = userSource(['strict', 'loop'], (source, flows) => {
    flows.loop!.ticket.vertices.green!.route = { ok: 'red' };
    addMisfit(source, 'command');
  });
  const checked = await checkOf(sources(repositorySource(), user));
  assert.deepEqual(errorLines(checked), [`error: user:flows.loop.ticket: ${loopCycle} [unbounded-cycle]`]);
  assert.deepEqual([...checked.misfits.keys()], ['user:strict']);
});

// Each graph check's code in lib/validate/graph.ts and the module only it imports, read from their source so a new one
// joins the case below.
const GRAPH_SOURCES = ['graph.ts', 'route-facts.ts'].map((file) =>
  readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'lib/validate', file), 'utf8'),
);
const GRAPH_CODES = report.PROBLEM_CODES.filter((code) => GRAPH_SOURCES.some((source) => source.includes(`'${code}'`)));

// A change to Flow `other` that fires each graph check.
const GRAPH_CASES: Record<string, (user: Repository, other: Flow) => void> = {
  'unrouted-outcome': (_user, other) => {
    other.ticket.routes = {};
  },
  'write-without-commit': (user, other) => {
    const { implement } = user.procedures;
    user.procedures.uncommitted = { ...implement!, actions: implement!.actions.filter(({ id }) => id !== 'commit') };
    other.ticket.vertices.green!.procedure = 'uncommitted';
  },
  'commit-without-check': (user, other) => {
    const unchecked = structuredClone(user.procedures.implement!);
    (unchecked as unknown as { claimTokens: { ok: { requires: string[] } } }).claimTokens.ok.requires = [];
    user.procedures.unchecked = unchecked;
    other.ticket.vertices.green!.procedure = 'unchecked';
  },
  'unbounded-cycle': (_user, other) => {
    other.ticket.vertices.green!.route = { ok: 'red' };
  },
  'exhausted-loop': (_user, other) => {
    Object.assign(other.ticket.vertices.red!, { max: 1, exhausted: 'green' });
    Object.assign(other.ticket.vertices.green!, { max: 1, exhausted: 'red' });
  },
  'pr-ready-skippable': (_user, other) => {
    other.ticket.vertices.red!.route = { ok: { end: 'ready-for-qa' } };
  },
  'required-input-unsure': (_user, other) => {
    (other.ticket.vertices.green!.inputs as Record<string, unknown>).previous = { from: 'green.commit.files' };
  },
  'optional-input-unsure': (_user, other) => {
    const previous = { from: 'green.commit.files', optional: true };
    (other.ticket.vertices.green!.inputs as Record<string, unknown>).previous = previous;
  },
  'unreachable-vertex': (_user, other) => {
    other.ticket.vertices.orphan = { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } };
  },
};

// The codes the check reports at user Flow `other`, its errors' and its warnings'.
const codesAtOther = (checked: configurationCheck.CheckedConfiguration) =>
  [...checked.configurationErrors, ...checked.warnings]
    .filter((problem) => problem.at.startsWith('user:flows.other'))
    .map((problem): string => problem.code);

// A missing command holds only the Flows that use it: every graph check still runs on each other user Flow, for every
// Check kind that names a command, whether a Flow runs the misfit or none does.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('every graph check runs on a user Flow beside a misfit of every command-naming Check kind, used or not', async () => {
  assert.deepEqual(Object.keys(GRAPH_CASES).sort(), [...GRAPH_CODES].sort());
  assert.deepEqual(COMMAND_KINDS, ['command', 'tests-fail']);
  const missed: string[] = [];
  for (const [code, change] of Object.entries(GRAPH_CASES)) {
    const alone = userSource(['other'], (user, flows) => change(user, flows.other!));
    // The case fires its check without a misfit, so a code missing below is a check the misfit skipped.
    assert.ok(codesAtOther(await checkOf(sources(repositorySource(), alone))).includes(code), code);
    for (const kind of COMMAND_KINDS) {
      for (const flows of [['strict', 'other'], ['other']]) {
        const user = userSource(flows, (source, declared) => {
          change(source, declared.other!);
          addMisfit(source, kind);
        });
        const checked = await checkOf(sources(repositorySource(), user));
        if (!codesAtOther(checked).includes(code))
          missed.push(`${code} beside a ${kind} misfit in ${flows.join(', ')}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

// A Flow that uses a misfit stays a misfit, a warning in gg doctor (Q21): its own graph checks wait, as before #433, so
// none of their problems becomes an error that refuses every Run. The hold skips every graph check at once.
test('a user Flow that uses a misfit is held from its own graph checks', async () => {
  for (const kind of COMMAND_KINDS) {
    const user = userSource(['strict'], (source, flows) => {
      flows.strict!.ticket.vertices.green!.route = { ok: 'red' };
      addMisfit(source, kind);
    });
    const checked = await checkOf(sources(repositorySource(), user));
    const atStrict = [...checked.configurationErrors, ...checked.warnings].filter((problem) =>
      problem.at.startsWith('user:flows.strict'),
    );
    assert.deepEqual(atStrict, [], kind);
    assert.deepEqual([...checked.misfits.keys()], ['user:strict'], kind);
  }
});

// A Check whose command is not a name is an error in any repository, but a Procedure's error holds only the Vertices
// that name it, so a user Flow none of whose Vertices does is graph-checked beside it (#449, Q3 A).
test('a user Check whose command is not a name holds no graph check of a user Flow that does not use it', async () => {
  const user = userSource(['loop'], (source, flows) => {
    flows.loop!.ticket.vertices.green!.route = { ok: 'red' };
    addMisfit(source, 'command', ['lint']);
  });
  assert.deepEqual(
    (await checkOf(sources(repositorySource(), user))).configurationErrors.map(
      (problem) => `${problem.at} ${problem.code}`,
    ),
    ['user:procedures.misfit.actions[1] undeclared-command', 'user:flows.loop.ticket unbounded-cycle'],
  );
});

// The repository's own missing command refuses every Run, and holds only the Vertices that name its Procedure, so a
// repository Flow that does not use it is graph-checked beside it (#449, Q3 A, reversing #433's rule).
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test("a repository Procedure's missing command holds no graph check of a repository Flow that does not use it", async () => {
  const repository = repositorySource();
  repository.flows.loop = structuredClone(repository.flows.default!);
  repository.flows.loop.ticket.vertices.green!.route = { ok: 'red' };
  addMisfit(repository, 'command');
  assert.deepEqual(errorLines(await checkOf(sources(repository))), [
    'error: procedures.misfit.actions[1]: Check test names command "lint", which the repository does not declare ' +
      '[undeclared-command]',
    `error: flows.loop.ticket: ${loopCycle} [unbounded-cycle]`,
  ]);
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
  const checked = await checkOf(sources(repository, user), { commonDir });
  assert.deepEqual(errorLines(checked), []);
  assert.deepEqual(
    checked.recordProblems().map((problem) => problem.at),
    expected,
  );
  assert.ok(!checked.recordProblems().some((problem) => problem.at === `records.${declared.execution}`));
  assert.equal(
    report.line('error', checked.recordProblems()[0]!),
    'error: records.ticket-1: Execution Record ticket-1 runs Flow gone, which is no longer declared; declare it ' +
      'again to resume it, or run gg work abandon 1 to start over [unknown-flow]',
  );
});

// gg run holds a Ticket whose row the reader refuses for a human, so gg doctor lists that row as an error beside the
// records whose Flow is gone, one for each way a row is refused, naming the field the reader refused when it names one
// (#439, Q1 A).
test('gg doctor reports a corrupt Execution Record', async (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-configuration-check-');
  corruptRecords.CORRUPTIONS.forEach((corruption, index) => {
    seededRecords.seed(commonDir, index + 1, 'default', seededRecords.SHAPES[0]!);
    corruptRecords.plant(commonDir, index + 1, corruption);
  });
  seededRecords.seed(commonDir, 9, 'gone', seededRecords.SHAPES[0]!);
  const checked = await checkOf(sources(repositorySource()), { commonDir });
  assert.deepEqual(errorLines(checked), []);
  assert.deepEqual(
    checked.recordProblems().map((problem) => [problem.at, problem.code, problem.params]),
    [
      ...corruptRecords.CORRUPTIONS.map(({ field, reason }, index) => [
        `records.ticket-${index + 1}`,
        'corrupt-record',
        { ticket: index + 1, ...(field !== undefined && { field }), reason },
      ]),
      ['records.ticket-9', 'unknown-flow', { name: 'gone', declared: ['default'], ticket: 9 }],
    ],
  );
  assert.equal(
    report.line('error', checked.recordProblems()[0]!),
    'error: records.ticket-1: Execution Record ticket-1 cannot be read: its flow is not a string; gg run holds ' +
      'Ticket 1 for a human, and gg work abandon 1 forgets it [corrupt-record]',
  );
});

test('the checked configuration carries the Settings only when the settings hold no error', async () => {
  const valid = await checkOf(sources(repositorySource()));
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
  assert.equal((await checkOf(sources(repository))).settings, undefined);
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
