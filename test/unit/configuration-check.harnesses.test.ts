// The Harnesses' preflight and doctor in the configuration check: an area file of configuration-check.test.ts, which is
// at its line cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as config from '../../lib/config.ts';
import * as configurationCheck from '../../lib/configuration-check.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as report from '../../lib/validate/report.ts';
import * as caseEnv from '../support/case-env.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import type * as golden from '../support/golden.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as storeAlias from '../support/store-alias.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const REPOSITORY_FILE = '/repo/.agents/gg/gg.json';
const USER_FILE = '/home/.agents/gg/gg.json';
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };
const HARNESSES = { fake: fakeHarness.fakeHarness() };

// The run fixture's repository source (a red, green and publish Flow on the fake Harness), which a case changes before
// it checks.
const repositorySource = () => runFixture.testConfig('', {});

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

// The preflight stop for Claude is gone (#425, G7): the Claude Harness shipped builds passes preflight over a CLI
// logged in at the minimum version, whose cheap checks preflight runs (#427).
test('preflight admits the Claude Harness shipped builds over a logged-in CLI', async (t) => {
  storeAlias.unpackagedShellFirst(t);
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude' });
  const { claude } = shipped.shipped(recordedCli.recordedCli());
  assert.deepEqual(errorLines(await checkOf(sources(repository), { harnesses: { claude } })), []);
});

// Q1 A: a failed check is one error for the Harness, at no configuration path, naming the check.
test('preflight fails a Flow whose Claude CLI is logged out', async (t) => {
  storeAlias.unpackagedShellFirst(t);
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
      doctored.push([name, { probe: (options as runContext.DoctorOptions).probe }]);
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

// Q4 A of #484: a Harness's doctor sees each Agent it runs once, by the name the Vertices use, so Claude's can warn
// about an Agent's listed plugins; an Agent no admitted Flow runs is not given.
test("each Harness's doctor is given, by name, the Agents the admitted Flows run on it, and no other", async () => {
  const repository = repositorySource();
  const other = repositorySource().flows.default as golden.ConfiguredFlow;
  repository.agents.other = { ...repository.agents.implementer, harness: 'other' };
  (other.ticket.vertices.red as { use: string }).use = 'other';
  repository.flows.other = other;
  const given = new Map<string, unknown>();
  const recording = (name: string) => ({
    ...fakeHarness.fakeHarness({ name }),
    doctor: (options: runContext.DoctorOptions) => {
      given.set(name, options.agents);
      return Promise.resolve({ ok: true, checks: [] });
    },
  });
  await checkOf(sources(repository), { harnesses: { fake: recording('fake'), other: recording('other') } });
  assert.ok(Object.hasOwn(repository.agents, 'reviewer'), 'an Agent no Vertex runs is declared');
  assert.deepEqual(Object.fromEntries(given), {
    fake: { implementer: repository.agents.implementer },
    other: { other: repository.agents.other },
  });
});

// Every pass and failure a check can report, each a warning or an error.
const DOCTOR_CHECKS: runContext.DoctorCheck[] = [true, false].flatMap((ok) =>
  (['warning', 'error'] as const).map((severity) => ({
    name: `${ok ? 'passing' : 'failing'}-${severity}`,
    ok,
    severity,
    message: `the ${severity} check ${ok ? 'passed' : 'failed'}`,
  })),
);

// #494, Q1 A: each Harness check that ran and passed is one pass naming its Harness and check, in cheap mode and under
// --probe alike; a failed one stays its one Problem and no pass, and a Harness with no checks, no doctor, or a doctor
// that throws, passes nothing.
test('each passed doctor check is one pass naming its Harness, and no failed or absent check passes', async () => {
  const repository = repositorySource();
  const doctors: Record<string, ((options: unknown) => Promise<runContext.DoctorReport>) | undefined> = {
    checked: () => Promise.resolve({ ok: false, checks: DOCTOR_CHECKS }),
    undoctored: undefined,
    throwing: () => Promise.reject(new Error('the doctor broke\nat its second line')),
  };
  for (const name of Object.keys(doctors)) {
    const flow = repositorySource().flows.default as golden.ConfiguredFlow;
    repository.agents[name] = { ...repository.agents.implementer, harness: name };
    (flow.ticket.vertices.red as { use: string }).use = name;
    repository.flows[name] = flow;
  }
  const harnesses = Object.fromEntries(
    Object.entries(doctors).map(([name, doctor]) => [name, { ...fakeHarness.fakeHarness({ name }), doctor }]),
  );
  for (const probe of [false, true]) {
    const checked = await configurationCheck.check({
      config: sources(repository),
      harnesses: { ...HARNESSES, ...harnesses },
      probe,
    });
    const failedText = (problems: report.Problem[]) =>
      problems.filter((problem) => problem.code === 'harness-doctor-failed').map((problem) => problem.message);
    const textOf = (harness: string, check: runContext.DoctorCheck) =>
      `harness ${harness}: ${check.name}: ${check.message}`;
    const failed = DOCTOR_CHECKS.filter(({ ok }) => !ok);
    assert.deepEqual(
      checked.passes,
      DOCTOR_CHECKS.filter(({ ok }) => ok).map((check) => textOf('checked', check)),
      `probe ${probe}`,
    );
    assert.deepEqual(
      failedText(checked.warnings),
      failed.filter(({ severity }) => severity === 'warning').map((check) => textOf('checked', check)),
    );
    assert.deepEqual(failedText(checked.environmentErrors), [
      ...failed.filter(({ severity }) => severity === 'error').map((check) => textOf('checked', check)),
      'harness throwing: doctor: the doctor broke',
    ]);
  }
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

// An exec whose launch records its call and starts nothing, and which runs no containment probe.
const launchless = (launched: unknown[]): Parameters<typeof shipped.shipped>[0] => ({
  launch: (...args) => {
    launched.push(args);
    throw new Error('no CLI starts at this preflight');
  },
  childInJob: () => Promise.reject(new Error('no containment probe runs at this preflight')),
});

// A Codex Agent with nothing to list starts no listing at preflight, where only the doctor's cheap commands start
// (#484), and with its run built Codex passes preflight: its stop is gone (#482 decision 8).
test('the shipped Codex Harness passes preflight, starting no listing', async () => {
  const repository = repositorySource();
  // Codex declares network unsupported, so the implementer drops it, which is not this case's subject (owner, T1).
  delete repository.agents.implementer!.network;
  Object.assign(repository.agents.implementer!, { harness: 'codex' });
  const launched: unknown[] = [];
  const { codex } = shipped.shipped(launchless(launched));
  const checked = await checkOf(sources(repository), { harnesses: { codex } });
  const refused = errorLines(checked).filter((line) => line.endsWith('[harness-preflight-failed]'));
  assert.deepEqual(refused, []);
  const started = launched.map((args) => (args as [{ args: string[] }])[0].args[0]);
  const listings = started.filter((command) => command === 'plugin' || command === 'mcp');
  assert.deepEqual(listings, [], started.join(', '));
});

// No Harness is a stub at preflight, so neither generic shortcut remains (#482 decision 8): a Harness lacking any
// contract member, run and validate among them, is refused at each of its Vertices by the contract check's own error.
test('preflight refuses a Harness lacking any contract member with the contract check', async () => {
  const refused: Record<string, string[]> = {};
  const expected: Record<string, string[]> = {};
  for (const member of contract.HARNESS_METHODS) {
    const fake: Record<string, unknown> = { ...fakeHarness.fakeHarness() };
    delete fake[member];
    const { environmentErrors } = await checkOf(sources(repositorySource()), { harnesses: { fake } });
    refused[member] = environmentErrors.map((problem) => `${problem.code}: ${problem.message}`);
    // At each Vertex of the fixture Flow that runs an Agent
    const reason = `harness fake: harness is missing ${member}`;
    expected[member] = ['red', 'green'].map((id) => `harness-preflight-failed: vertex ${id}: ${reason}`);
  }
  assert.deepEqual(refused, expected);
});

// Codex declares network unsupported (Q15 A), so it is the validator's one error at its key, which no Vertex's Harness
// preflight repeats (ADR 0026, #481 DoD 1); contextBudget, which the hand-off hook enforces (#485), is no error.
test('a Codex Agent setting network is one error at its key, not repeated, and its contextBudget none', async (t) => {
  // The hook-file check reads gg's Codex home, which the case keeps away from the user's.
  caseEnv.caseEnv(t, { GG_HOME: tempDirectory.tempDirectory(t, 'gg-home-') });
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'codex', network: false, contextBudget: 100000 });
  const { codex } = shipped.shipped(launchless([]));
  const checked = await checkOf(sources(repository), { harnesses: { codex } });
  assert.deepEqual(
    checked.configurationErrors.map((problem) => `${problem.at} ${problem.code}`),
    ['agents.implementer.network unenforceable-permission-intent'],
  );
  const repeated = checked.environmentErrors.filter((problem) => /\bnetwork\b|contextBudget/.test(problem.message));
  assert.deepEqual(repeated, []);
});

test("preflight fails a Claude Agent's plugin that is not installed on the Harness's resolveTools", async (t) => {
  const repository = repositorySource();
  Object.assign(repository.agents.implementer!, { harness: 'claude', plugins: ['gg-no-such-plugin'] });
  const claudeModule = await import('../../lib/harnesses/claude.ts');
  const configDirectory = tempDirectory.tempDirectory(t, 'gg-claude-home-');
  const claude = { ...fakeHarness.fakeHarness({ name: 'claude' }), ...claudeModule.createClaude({ configDirectory }) };
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
