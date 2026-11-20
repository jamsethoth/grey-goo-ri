// gg doctor's checks of the CLI each used Harness starts (#427): over the Claude Harness shipped builds, its CLI
// answering in-process as recorded (Q2 A), in cheap mode and under --probe, and the same errors gg run's preflight
// gives.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as run from '../../lib/run.ts';
import * as caseEnv from '../support/case-env.ts';
import * as exampleLayer from '../support/example-layer.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const FAKE_HARNESS = fakeHarness.fakeHarness();
// A case that asks nobody reads no labels.
const DEPS = { gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh), cwd: '/repo' };
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// `repository` as the repository's source, beside a user source that holds only the machine settings.
const sources = (repository: config.Source): config.Configuration => ({
  repository,
  user: { maxParallel: 2, worktreeRoot: '~/worktrees', files: {} },
  repositoryFile: '/repo/.agents/gg/gg.json',
  userFile: '/home/.agents/gg/gg.json',
});

// The example Layer as loadLayers gives it, with every Agent on the Claude Harness, as gg init --harness claude writes
// it: seven Vertices on one CLI.
function claudeExample() {
  const layer = exampleLayer.config();
  layer.files = Object.fromEntries(
    exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json').map((name) => [
      name,
      file(exampleLayer.fixtureText(name)),
    ]),
  );
  for (const agent of Object.values<Record<string, unknown>>(layer.agents)) agent.harness = 'claude';
  return layer;
}

// gg doctor over the Claude Harness shipped builds, its CLI answering as recorded, changed by `state`, and every
// launch the Harness asked for.
async function doctorOverCli(state: recordedCli.CliState = {}, { probe = false } = {}) {
  const cli = recordedCli.recordedCli(state);
  const harnesses = { ...shipped.shipped(cli), fake: FAKE_HARNESS };
  const result = await doctor.doctor({ config: sources(claudeExample()), ...DEPS, harnesses, probe });
  return { ...result, launches: cli.launches };
}

const linesOf = (text: string, severity: 'error' | 'warning') =>
  text.split('\n').filter((line) => line.startsWith(`${severity}: `));
const doctorLines = (text: string, severity: 'error' | 'warning') =>
  linesOf(text, severity).filter((line) => line.endsWith(' [harness-doctor-failed]'));

// A failed check prints once for its Harness, however many Vertices run on it (Q1 A), and names the Harness and the
// check, and is gg doctor's only error.
function assertOneDoctorError(text: string, check: string) {
  assert.deepEqual(linesOf(text, 'error'), doctorLines(text, 'error'), text);
  assert.equal(doctorLines(text, 'error').length, 1, text);
  const [line] = doctorLines(text, 'error');
  assert.ok(line!.includes('claude') && line!.includes(check), line);
}

// What the --bare line says today, which the cheap mode reads in place of a model probe (decision 2). The CLI wraps its
// help to a width, so the words may break across lines.
const BARE_AUTH = /OAuth\s+and\s+keychain\s+are\s+never\s+read/;
const changedHelp = (text: string) => text.replace(BARE_AUTH, 'OAuth is read from CLAUDE_CODE_OAUTH_TOKEN');
const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

test('gg doctor reports a Claude CLI older than the minimum', async () => {
  const { text, exitCode } = await doctorOverCli({ version: recordedCli.OLD_VERSION });
  assertOneDoctorError(text, 'version');
  const [line] = doctorLines(text, 'error');
  assert.ok(line!.includes(recordedCli.OLD_VERSION) && line!.includes('2.1.328'), line);
  assert.equal(exitCode, 1);
});

test('gg doctor reports a logged-out Claude CLI', async () => {
  const { text, exitCode } = await doctorOverCli({ loggedOut: true });
  assertOneDoctorError(text, 'login');
  assert.equal(exitCode, 1);
});

test('gg doctor reports a missing Claude CLI', async () => {
  const { text, exitCode } = await doctorOverCli({ missing: true });
  assertOneDoctorError(text, 'executable');
  assert.equal(exitCode, 1);
});

// Every state of the CLI a cheap check meets, so every argv cheap mode starts is seen.
const CLI_STATES: [string, recordedCli.CliState][] = [
  ['a logged-in CLI at the minimum', {}],
  ['an old CLI', { version: recordedCli.OLD_VERSION }],
  ['a logged-out CLI', { loggedOut: true }],
  ['a CLI whose help no longer says bare mode never reads OAuth', { help: changedHelp }],
  ['a missing CLI', { missing: true }],
];

// Decision 1 (Q5 A): only --probe makes a model call, so every argv cheap mode starts is one of its three commands.
test('gg doctor without --probe runs no model call', async () => {
  const started: string[][] = [];
  for (const [, state] of CLI_STATES) started.push(...(await doctorOverCli(state)).launches.map(({ args }) => args));
  for (const args of started)
    assert.ok(
      recordedCli.CHEAP_ARGVS.some((argv) => sameArgv(argv, args)),
      `cheap mode started claude ${args.join(' ')}`,
    );
  for (const argv of recordedCli.CHEAP_ARGVS)
    assert.ok(
      started.some((args) => sameArgv(args, argv)),
      `cheap mode checks the CLI with claude ${argv.join(' ')}`,
    );
});

// Decision 3: the profile probe runs a model call with the launch profile's argv and environment.
test('gg doctor --probe runs the profile probe', async () => {
  const { launches } = await doctorOverCli({}, { probe: true });
  const profile = launches.filter(({ args }) => args.includes('-p') && !args.includes('--bare'));
  assert.equal(profile.length, 1, JSON.stringify(launches.map(({ args }) => args)));
  const [{ args, env }] = profile as [(typeof profile)[number]];
  for (const flag of ['--setting-sources', '--strict-mcp-config', '--append-system-prompt-file'])
    assert.ok(args.includes(flag), `the profile probe passes ${flag}`);
  assert.equal(env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
});

// The bare probe's token, left out of the case's environment until it ends.
function withoutToken(t: TestContext) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    if (token !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  });
}

// Decision 3: with a long-lived token, --probe also runs the --bare probe.
test('gg doctor --probe runs the bare probe when CLAUDE_CODE_OAUTH_TOKEN is set', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const { launches } = await doctorOverCli({}, { probe: true });
  assert.equal(launches.filter(({ args }) => args.includes('-p') && args.includes('--bare')).length, 1);
});

// Q5 A: no token skips the bare probe with a warning naming claude setup-token; the profile probe still runs.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('gg doctor --probe without CLAUDE_CODE_OAUTH_TOKEN skips the bare probe with a warning naming claude setup-token', async (t) => {
  withoutToken(t);
  const { text, launches, exitCode } = await doctorOverCli({}, { probe: true });
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('--bare')),
    [],
  );
  assert.equal(launches.filter(({ args }) => args.includes('-p')).length, 1, 'the profile probe runs');
  const warnings = doctorLines(text, 'warning');
  assert.equal(warnings.length, 1, text);
  assert.ok(warnings[0]!.includes('claude setup-token'), warnings[0]);
  assert.equal(exitCode, 0, text);
});

// Q4 A: a changed --bare line is a sign, not proof, that bare mode takes a subscription, so it warns and stops no Run.
test('gg doctor warns, naming gg doctor --probe, when the help stops saying bare mode never reads OAuth', async () => {
  assert.match(recordedCli.recordedHelp(), BARE_AUTH, 'the recorded --bare line says OAuth is never read');
  const { text, exitCode } = await doctorOverCli({ help: changedHelp });
  assert.deepEqual(linesOf(text, 'error'), [], text);
  const warnings = doctorLines(text, 'warning');
  assert.equal(warnings.length, 1, text);
  assert.ok(warnings[0]!.includes('gg doctor --probe'), warnings[0]);
  assert.equal(exitCode, 0);
});

// V1, ADR 0014: each state of the CLI a cheap check fails, by what fails.
const FAILING_CLI = CLI_STATES.filter(([, state]) => Boolean(state.missing || state.loggedOut || state.version));

test("gg doctor gives the error gg run's preflight refuses each failing Claude CLI with, line for line", async (t) => {
  assert.equal(FAILING_CLI.length, 3);
  for (const [fails, state] of FAILING_CLI) {
    const harnesses = { ...shipped.shipped(recordedCli.recordedCli(state)), fake: FAKE_HARNESS };
    const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-doctor-cli-parity-');
    const configuration = sources(runFixture.testConfig('', { harness: 'claude' }));
    let refused: string[] = [];
    await run.admitConfiguration({ commonDir, config: configuration, harnesses }).catch((err: Error) => {
      refused = err.message.split('\n').filter((line) => line.startsWith('error: '));
    });
    assert.equal(
      refused.filter((line) => line.endsWith(' [harness-doctor-failed]')).length,
      1,
      `gg run refuses ${fails}`,
    );
    const { text } = await doctor.doctor({ config: configuration, ...DEPS, harnesses, commonDir });
    assert.deepEqual(linesOf(text, 'error'), refused, fails);
  }
});
