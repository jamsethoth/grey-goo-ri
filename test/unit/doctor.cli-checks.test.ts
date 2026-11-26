// gg doctor's checks of the CLI each used Harness starts (#427): over the Claude Harness shipped builds, its CLI
// answering in-process as recorded (Q2 A), in cheap mode and under --probe, and the same errors gg run's preflight
// gives.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as run from '../../lib/run.ts';
import * as caseEnv from '../support/case-env.ts';
import * as claudeRecordings from '../support/claude-recordings.ts';
import * as exampleSource from '../support/example-source.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const FAKE_HARNESS = fakeHarness.fakeHarness();
// A case that asks nobody reads no labels.
const DEPS = { gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh), cwd: '/repo' };
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });

// `repository` as the repository's source, beside a user source that holds only the machine settings; the files it
// names move beside it. A type parameter, so the example passes as its own type and is not widened to a Source.
const sources = <Repository extends config.Source & { files?: config.SourceFiles }>({
  files = {},
  ...repository
}: Repository): config.Configuration => ({
  repository,
  user: { maxParallel: 2, worktreeRoot: '~/worktrees' },
  repositoryFile: '/repo/.agents/gg/gg.json',
  userFile: '/home/.agents/gg/gg.json',
  files: { repository: files, user: {} },
});

// The example Source as loadSources gives it, with every Agent on the Claude Harness, as gg init --harness claude
// writes it: seven Vertices on one CLI.
function claudeExample() {
  const source = exampleSource.config();
  exampleSource.putAt(
    source,
    ['files'],
    Object.fromEntries(
      exampleSource.WRITTEN_NAMES.filter((name) => name !== 'gg.json').map((name) => [
        name,
        file(exampleSource.fixtureText(name)),
      ]),
    ),
  );
  for (const agent of Object.values(source.agents)) agent.harness = 'claude';
  return source;
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
// The profile probe's call: a model call that is neither the --bare probe nor the copy of its Session.
const isProfileCall = ({ args }: { args: string[] }) =>
  args.includes('-p') && !args.includes('--bare') && !args.includes('--fork-session');

// PATH as a directory holding only `files`, until the case ends: on win32 the shell check finds PowerShell there.
function onlyOnPath(t: TestContext, ...files: string[]) {
  const directory = tempDirectory.tempDirectory(t, 'gg-doctor-path-');
  for (const name of [...(process.platform === 'win32' ? ['pwsh.exe'] : []), ...files])
    writeFileSync(join(directory, name), '');
  caseEnv.caseEnv(t, { PATH: directory });
}
const GG_FILE = process.platform === 'win32' ? 'gg.cmd' : 'gg';

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
  const profile = launches.filter(isProfileCall);
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
  onlyOnPath(t, GG_FILE);
  const { text, launches, exitCode } = await doctorOverCli({}, { probe: true });
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('--bare')),
    [],
  );
  assert.equal(launches.filter(isProfileCall).length, 1, 'the profile probe runs');
  const warnings = doctorLines(text, 'warning');
  assert.equal(warnings.length, 1, text);
  assert.ok(warnings[0]!.includes('claude setup-token'), warnings[0]);
  assert.equal(exitCode, 0, text);
});

// Q4 A: a changed --bare line is a sign, not proof, that bare mode takes a subscription, so it warns and stops no Run.
test('gg doctor warns, naming gg doctor --probe, when the help stops saying bare mode never reads OAuth', async (t) => {
  onlyOnPath(t, GG_FILE);
  assert.match(recordedCli.recordedHelp(), BARE_AUTH, 'the recorded --bare line says OAuth is never read');
  const { text, exitCode } = await doctorOverCli({ help: changedHelp });
  assert.deepEqual(linesOf(text, 'error'), [], text);
  const warnings = doctorLines(text, 'warning');
  assert.equal(warnings.length, 1, text);
  assert.ok(warnings[0]!.includes('gg doctor --probe'), warnings[0]);
  assert.equal(exitCode, 0);
});

// D2 A: a cheap command that times out keeps its reason, and a hung --help claims no change to its --bare line.
test('gg doctor reports the timeout of a claude --version or --help that does not finish', async () => {
  const checksOf = async (hangs: string) =>
    (await claude.createCli(recordedCli.recordedCli({ hangs })).doctor({ probe: false, agents: {} })).checks;
  const version = (await checksOf('--version')).find(({ name }) => name === 'version');
  assert.ok(version?.message.endsWith('claude --version timed out'), version?.message ?? 'no version check');
  const help = (await checksOf('--help')).find(({ name }) => name === 'bare-help');
  assert.equal(help?.severity, 'warning');
  assert.ok(help.message.endsWith('claude --help timed out') && !help.message.includes('no longer'), help.message);
});

// D5 A: a cheap command that exits with an error names its exit; a failed --help claims no change to its --bare line.
test('gg doctor names the exit of a claude --version or --help that fails having printed nothing', async () => {
  const checksOf = async (fails: string) =>
    (await claude.createCli(recordedCli.recordedCli({ fails })).doctor({ probe: false, agents: {} })).checks;
  const version = (await checksOf('--version')).find(({ name }) => name === 'version');
  assert.ok(version?.message.endsWith('claude --version exited 1'), version?.message ?? 'no version check');
  const help = (await checksOf('--help')).find(({ name }) => name === 'bare-help');
  assert.equal(help?.severity, 'warning');
  assert.ok(help.message.endsWith('claude --help exited 1') && !help.message.includes('no longer'), help.message);
});

// Each way a command ends printing nothing, and the reason its check names.
const SILENT_ENDINGS: ['hangs' | 'fails' | 'killed', string][] = [
  ['hangs', 'timed out'],
  ['fails', 'exited 1'],
  ['killed', 'ended by SIGKILL'],
];

// #460: a cheap command is named by its whole argv, and a POSIX crash names its signal, over every cheap argv and
// every silent ending; a failed --help claims no change to its --bare line.
test('gg doctor names a failed claude auth status whole and a cheap command ended by a signal', async () => {
  const unnamed: string[] = [];
  for (const argv of recordedCli.CHEAP_ARGVS)
    for (const [ending, reason] of SILENT_ENDINGS) {
      const { checks } = await claude
        .createCli(recordedCli.recordedCli({ [ending]: argv[0] }))
        .doctor({ probe: false, agents: {} });
      const expected = `claude ${argv.join(' ')} ${reason}`;
      if (!checks.some(({ message }) => message.endsWith(expected) && !message.includes('no longer')))
        unnamed.push(expected);
    }
  assert.deepEqual(unnamed, []);
});

// D7 A of #427: the recorded CLI's hangs and fails match only when a case sets them.
test('the recorded CLI has no answer for an empty argv when no case sets hangs or fails', async () => {
  await assert.rejects(recordedCli.recordedCli().launch({ command: 'claude', args: [] }), /has no answer/);
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

// The Claude Harness's checks under --probe over the CLI as recorded, changed by `state`, its launches and the
// settings file each launch named, read as it starts: the probe removes them after.
async function probeChecks(state: recordedCli.CliState) {
  const cli = recordedCli.recordedCli(state);
  const settings: (Record<string, unknown> | undefined)[] = [];
  const launch: typeof cli.launch = (options) => {
    const index = options.args.indexOf('--settings');
    const path = index < 0 ? undefined : options.args[index + 1];
    settings.push(path === undefined ? undefined : (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>));
    return cli.launch(options);
  };
  const { checks } = await claude.createCli({ launch }).doctor({ probe: true, agents: {} });
  const named = (name: string) => checks.find((check) => check.name === name);
  const checked = {
    bare: named('bare-probe'),
    profile: named('profile-probe'),
    handoff: named('handoff-probe'),
    fork: named('fork-probe'),
  };
  return { ...checked, launches: cli.launches, settings };
}

// #460: a model call keeps the name claude -p when it fails, whatever its argv holds after -p.
test('gg doctor --probe names a timed-out model call claude -p', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const { bare, profile, handoff } = await probeChecks({ hangs: '-p' });
  for (const check of [bare, profile, handoff])
    assert.ok(check?.message.endsWith('claude -p timed out'), check?.message ?? 'no check');
});

type StreamLine = Record<string, unknown>;

// A stream recording with each line changed by `edit`, which drops a line by giving null.
const eachLine = (edit: (line: StreamLine) => StreamLine | null) => (stream: string) =>
  stream
    .split('\n')
    .filter(Boolean)
    .flatMap((text) => {
      const line = edit(JSON.parse(text) as StreamLine);
      return line ? [JSON.stringify(line)] : [];
    })
    .join('\n');
const isInit = (line: StreamLine) => line.type === 'system' && line.subtype === 'init';
const keySource = (source: string, line: StreamLine) => (isInit(line) ? { ...line, apiKeySource: source } : line);
const success = () => claudeRecordings.lines('success').join('\n');

// F1: only the subscription token may answer the --bare probe, so gg's other credentials are blanked for its launch.
test('the --bare probe blanks the other credentials bare mode takes', async (t) => {
  caseEnv.caseEnv(t, {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token',
    ANTHROPIC_API_KEY: 'sk-ant-case-key',
    CLAUDE_CODE_USE_BEDROCK: '1',
  });
  const { launches } = await probeChecks({});
  const [bare] = launches.filter(({ args }) => args.includes('--bare'));
  for (const name of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])
    assert.equal(bare?.env?.[name], '', `the --bare launch blanks ${name}`);
});

// D3 A: a provider switch would send the call to that provider, so every one gg's environment sets is blanked, by
// prefix, as a later CLI may add one.
test('the --bare probe blanks every CLAUDE_CODE_USE_ switch set in its environment', async (t) => {
  const switches = ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_A_LATER_PROVIDER', 'claude_code_use_mantle'];
  caseEnv.caseEnv(t, {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token',
    ...Object.fromEntries(switches.map((name) => [name, '1'])),
  });
  const { launches } = await probeChecks({});
  const [bare] = launches.filter(({ args }) => args.includes('--bare'));
  for (const name of switches) assert.equal(bare?.env?.[name], '', `the --bare launch blanks ${name}`);
});

// D6 A: another Anthropic credential, endpoint or header, or a settings file's env block, could answer in the token's
// place, so the --bare launch blanks every ANTHROPIC_ variable and loads no settings source.
test('the --bare probe blanks every ANTHROPIC_ variable gg holds and reads no settings file', async (t) => {
  const anthropic = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'Anthropic_Custom_Headers'];
  caseEnv.caseEnv(t, {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token',
    ...Object.fromEntries(anthropic.map((name) => [name, 'set'])),
  });
  const { launches } = await probeChecks({});
  const [bare] = launches.filter(({ args }) => args.includes('--bare'));
  for (const name of anthropic) assert.equal(bare?.env?.[name], '', `the --bare launch blanks ${name}`);
  assert.equal(bare?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the --bare launch leaves the token as gg holds it');
  const sources = bare?.args.indexOf('--setting-sources') ?? -1;
  assert.ok(sources !== -1 && bare?.args[sources + 1] === '', `the --bare launch loads no settings source`);
});

test('a --bare probe that ran on an API key warns, naming it, and passes nothing', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const { bare } = await probeChecks({
    bare: () => eachLine((line) => keySource('ANTHROPIC_API_KEY', line))(success()),
  });
  assert.equal(bare?.ok, false);
  assert.equal(bare.severity, 'warning');
  assert.ok(bare.message.includes('ANTHROPIC_API_KEY') && !bare.message.includes('adopt'), bare.message);
});

test("a --bare probe refused on an invalid API key warns with the CLI's reason, not a pass", async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const { bare } = await probeChecks({});
  assert.equal(bare?.ok, false);
  assert.equal(bare.severity, 'warning');
  assert.ok(bare.message.includes('Invalid API key'), bare.message);
});

test("a --bare probe refused with authentication_failed and no API key passes, keeping the CLI's reason", async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const { bare } = await probeChecks({ bare: eachLine((line) => keySource('none', line)) });
  assert.equal(bare?.ok, true, bare?.message ?? 'no bare-probe check');
  assert.ok(bare.message.includes('Invalid API key'), bare.message);
});

test('a --bare probe failed on another auth error with no API key warns that it failed', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const onHold = (line: StreamLine) =>
    keySource('none', line.type === 'assistant' ? { ...line, error: 'account_on_hold' } : line);
  const { bare } = await probeChecks({ bare: eachLine(onHold) });
  assert.equal(bare?.ok, false);
  assert.equal(bare.severity, 'warning');
  assert.ok(bare.message.includes('failed'), bare.message);
});

// The recorded refusal on no API key, each line changed by `edit`.
const onNone = (edit: (line: StreamLine) => StreamLine | null) => eachLine((line) => edit(keySource('none', line)));
const assistantError = (error: string) => onNone((line) => (line.type === 'assistant' ? { ...line, error } : line));
const ASSISTANT_ERRORS = [
  'account_on_hold',
  'oauth_org_not_allowed',
  'cloud_credential_error',
  'billing_error',
  'rate_limit',
  'overloaded',
  'an_unmapped_error',
];

// Every ending of the --bare call: only the refusal stand-in shows bare mode still refuses the token.
const BARE_ENDINGS: [string, (stream: string) => string][] = [
  ['the refusal stand-in', onNone((line) => line)],
  ['authentication_failed then no result line', onNone((line) => (line.type === 'result' ? null : line))],
  [
    'authentication_failed then a budget result',
    onNone((line) => (line.type === 'result' ? { ...line, subtype: 'error_max_budget_usd' } : line)),
  ],
  [
    'authentication_failed, a result not an error and init plugin errors',
    onNone((line) => {
      if (isInit(line)) return { ...line, plugin_errors: ['a plugin failed'] };
      return line.type === 'result' ? { ...line, is_error: false } : line;
    }),
  ],
  ...ASSISTANT_ERRORS.map((error): [string, (stream: string) => string] => [error, assistantError(error)]),
  ['a success', () => onNone((line) => line)(success())],
  ['the recorded refusal on ANTHROPIC_API_KEY', (stream) => stream],
];

// F3: a pass needs the parser's auth class as well as authentication_failed, so every other ending warns.
test('a --bare probe passes only on the refusal stand-in, of every ending', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  const passing: string[] = [];
  for (const [ending, bare] of BARE_ENDINGS) {
    const { bare: check } = await probeChecks({ bare });
    if (check?.ok) passing.push(ending);
    else assert.equal(check?.severity, 'warning', `${ending}: ${check?.message}`);
  }
  assert.deepEqual(passing, ['the refusal stand-in']);
});

// F2: a profile probe passes only on the evidence it checks, its init's plugin list and its structured answer.
test('the profile probe fails, naming the answer, when the call sent no structured answer', async () => {
  const noSchema = () => claudeRecordings.lines('no-schema').join('\n');
  const wordInResult = (line: StreamLine) => (line.type === 'result' ? { ...line, result: 'marigold' } : line);
  for (const profile of [noSchema, () => eachLine(wordInResult)(noSchema())]) {
    const { profile: check } = await probeChecks({ profile });
    assert.equal(check?.ok, false);
    assert.equal(check.severity, 'error');
    assert.ok(check.message.includes('no answer'), check.message);
  }
});

test('the profile probe fails, naming the plugin list, when the init sent none', async () => {
  const noInit = eachLine((line) => (isInit(line) ? null : line));
  const notAList = eachLine((line) => (isInit(line) ? { ...line, plugins: 'builtin' } : line));
  for (const edit of [noInit, notAList]) {
    const { profile } = await probeChecks({ profile: edit });
    assert.equal(profile?.ok, false);
    assert.equal(profile.severity, 'error');
    assert.ok(profile.message.includes('plugin list'), profile.message);
  }
});

test('the profile probe fails when its answer holds the CLAUDE.md word in any case', async () => {
  const capitalised = (line: StreamLine) =>
    line.type === 'result' ? { ...line, structured_output: { answer: 'Marigold' } } : line;
  const { profile } = await probeChecks({ profile: eachLine(capitalised) });
  assert.equal(profile?.ok, false);
  assert.ok(profile.message.includes('CLAUDE.md'), profile.message);
});

// Q5 A of #430: the profile probe's own call runs with the hand-off hook at a tiny budget and asks for hook events, so
// gg doctor --probe shows whether the hook runs under the real CLI.
test("gg doctor --probe checks the hand-off hook on the profile probe's call", async () => {
  const { handoff, launches } = await probeChecks({});
  const profile = launches.filter(isProfileCall);
  assert.equal(profile.length, 1, JSON.stringify(launches.map(({ args }) => args)));
  assert.ok(profile[0]!.args.includes('--include-hook-events'), JSON.stringify(profile[0]!.args));
  assert.equal(handoff?.ok, true, handoff?.message ?? 'no handoff-probe check');
});

const isHookLine = (line: StreamLine) =>
  line.type === 'system' && typeof line.subtype === 'string' && line.subtype.startsWith('hook_');
const answered = (fields: StreamLine) =>
  eachLine((line) =>
    line.type === 'result'
      ? { ...line, structured_output: { ...(line.structured_output as StreamLine), ...fields } }
      : line,
  );

// Every ending of the profile probe's call: only a PostToolUse hook that ran and a hand-off with its note pass.
const HANDOFF_ENDINGS: [string, (stream: string) => string][] = [
  ['the hook stand-in', (stream) => stream],
  ['no hook ran', eachLine((line) => (isHookLine(line) ? null : line))],
  ['the hook started and never answered', eachLine((line) => (line.subtype === 'hook_response' ? null : line))],
  ['the hook failed', eachLine((line) => (line.subtype === 'hook_response' ? { ...line, outcome: 'error' } : line))],
  ['only a PreToolUse hook ran', eachLine((line) => (isHookLine(line) ? { ...line, hook_event: 'PreToolUse' } : line))],
  ['the call ended without handing off', answered({ claim: 'ok', handoff: '' })],
  ['a hand-off with no note', answered({ handoff: '' })],
  ['a note without the handed-off claim', answered({ claim: 'ok' })],
  ['no structured answer', () => claudeRecordings.lines('no-schema').join('\n')],
  ['the success recording, with no hook', () => success()],
];

test('a hand-off probe passes only on the hook stand-in, of every ending', async () => {
  const outcomes: [string, boolean, string | undefined][] = [];
  for (const [ending, profile] of HANDOFF_ENDINGS) {
    const { handoff } = await probeChecks({ profile });
    outcomes.push([ending, handoff?.ok === true, handoff?.severity]);
  }
  assert.deepEqual(
    outcomes.filter(([, ok]) => ok).map(([ending]) => ending),
    ['the hook stand-in'],
  );
  assert.deepEqual(
    outcomes.filter(([, ok, severity]) => !ok && severity !== 'error'),
    [],
    'every other ending fails the probe as an error',
  );
});

test('the hand-off probe fails, naming the hook, when no PostToolUse hook ran', async () => {
  const { handoff } = await probeChecks({ profile: eachLine((line) => (isHookLine(line) ? null : line)) });
  assert.equal(handoff?.ok, false, handoff?.message ?? 'no handoff-probe check');
  assert.ok(handoff.message.includes('PostToolUse hook'), handoff.message);
});

// D6 A of #430: an agent past a hand-off asks its handed-off Session with gg ask-session, which its shell finds on
// PATH.
test('gg doctor warns, naming npm install -g, when gg is not on PATH', async (t) => {
  onlyOnPath(t);
  const { text, exitCode } = await doctorOverCli();
  const warnings = doctorLines(text, 'warning');
  assert.equal(warnings.length, 1, text);
  assert.ok(warnings[0]!.includes('gg-on-path') && warnings[0]!.includes('npm install -g'), warnings[0]);
  assert.equal(exitCode, 0, text);
  onlyOnPath(t, GG_FILE);
  assert.deepEqual(doctorLines((await doctorOverCli()).text, 'warning'), [], 'gg on PATH passes');
});

// D6 A of #430: --probe asks the hand-off probe's Session through a read-only copy, as gg ask-session asks one.
test("gg doctor --probe asks a read-only copy of the hand-off probe's Session", async () => {
  const { fork, launches, settings } = await probeChecks({});
  const [profile] = launches.filter(isProfileCall);
  const forks = launches.filter(({ args }) => args.includes('--fork-session'));
  assert.equal(forks.length, 1, JSON.stringify(launches.map(({ args }) => args)));
  const [{ args, cwd }] = forks as [(typeof forks)[number]];
  const forkSettings = settings[launches.indexOf(forks[0]!)];
  assert.ok(forkSettings, 'the copy launches with a settings file');
  assert.equal(forkSettings.hooks, undefined, 'the copy, like gg ask-session, has no budget and so no hand-off hook');
  const handedOff = JSON.parse(recordedCli.handoffStandIn().split('\n')[0]!) as { session_id: string };
  assert.equal(args[args.indexOf('--resume') + 1], handedOff.session_id);
  assert.ok(args.includes('--restricted'), 'the copy runs read-only');
  assert.equal(cwd, profile?.cwd, 'the copy runs where the CLI keeps the Session');
  assert.equal(fork?.ok, true, fork?.message ?? 'no fork-probe check');
});

// Every ending of the copy's call: only a copy with a Session of its own that answers passes.
const FORK_ENDINGS: [string, (stream: string) => string][] = [
  ['the fork stand-in', (stream) => stream],
  ['the handed-off Session resumed in place', () => success()],
  ['no structured answer', () => claudeRecordings.lines('no-schema').join('\n')],
  ['an empty answer', answered({ answer: ' ' })],
  ['a failed call', () => claudeRecordings.lines('auth-failure').join('\n')],
];

test('a fork probe passes only on the fork stand-in, of every ending, and fails as an error', async () => {
  const outcomes: [string, boolean, string | undefined][] = [];
  for (const [ending, fork] of FORK_ENDINGS) {
    const { fork: check } = await probeChecks({ fork });
    outcomes.push([ending, check?.ok === true, check?.severity]);
  }
  assert.deepEqual(
    outcomes.filter(([, ok]) => ok).map(([ending]) => ending),
    ['the fork stand-in'],
  );
  assert.deepEqual(
    outcomes.filter(([, ok, severity]) => !ok && severity !== 'error'),
    [],
    'every other ending fails the probe as an error',
  );
});

test('gg doctor --probe asks no copy when the hand-off probe failed', async () => {
  const { fork, launches } = await probeChecks({ profile: () => success() });
  assert.equal(fork, undefined);
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('--fork-session')),
    [],
  );
});

// The fork probe copies the profile probe's Session, so a profile call that names none fails it instead of skipping it.
test('a profile probe whose init line names no Session fails the fork probe', async () => {
  const { fork, launches } = await probeChecks({
    profile: eachLine((line) => (isInit(line) ? { ...line, session_id: undefined } : line)),
  });
  assert.equal(fork?.ok, false, fork?.message ?? 'no fork-probe check');
  assert.equal(fork.severity, 'error');
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('--fork-session')),
    [],
  );
});

const pluralOf = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// #494, Q1 A and Q2 A: every check the Claude Harness's doctor reports, read from the doctor itself in each state of
// the CLI, in cheap mode and under --probe: a passed one prints one `passed:` line naming its Harness, the check and
// its message, after the Flows and before the warnings; a failed one prints as before, its one warning or error and
// no passed line; and the summary counts no passed line.
test('gg doctor prints one passed line per passed check, before the warnings, and counts none', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  onlyOnPath(t, GG_FILE);
  let passedSeen = 0;
  for (const [state, cliState] of [
    ...CLI_STATES,
    ['a --bare refusal on no API key', { bare: onNone((line) => line) }] as const,
  ])
    for (const probe of [false, true]) {
      const where = `${state}, probe ${probe}`;
      const { checks } = await claude.createCli(recordedCli.recordedCli(cliState)).doctor({ probe, agents: {} });
      const { text } = await doctorOverCli(cliState, { probe });
      const lines = text.split('\n').slice(0, -1);
      const passed = lines.filter((line) => line.startsWith('passed: '));
      assert.deepEqual(
        passed,
        checks.filter(({ ok }) => ok).map(({ name, message }) => `passed: harness claude: ${name}: ${message}`),
        where,
      );
      passedSeen += passed.length;
      for (const severity of ['warning', 'error'] as const)
        assert.deepEqual(
          doctorLines(text, severity).toSorted(),
          checks
            .filter((check) => !check.ok && check.severity === severity)
            .map(({ name, message }) => `${severity}: harness claude: ${name}: ${message} [harness-doctor-failed]`)
            .toSorted(),
          where,
        );
      if (passed.length) {
        const first = lines.indexOf(passed[0]!);
        assert.deepEqual(lines.slice(first, first + passed.length), passed, `${where}: the passed lines run together`);
        assert.ok(
          lines.slice(0, first).every((line) => !/^(warning|error): /.test(line)),
          `${where}: no warning or error before the passed lines`,
        );
        assert.ok(
          lines.slice(first + passed.length, -1).every((line) => /^(warning|error): /.test(line)),
          `${where}: only warnings and errors between the passed lines and the summary`,
        );
      }
      const warned = linesOf(text, 'warning').length;
      assert.equal(
        lines.at(-1),
        `${pluralOf(linesOf(text, 'error').length, 'error')}${warned ? `, ${pluralOf(warned, 'warning')}` : ''}`,
        where,
      );
    }
  assert.ok(passedSeen > 0, 'some check passed');
});

// #494 DoD: gg doctor --probe shows each probe that ran and passed, so a passed probe differs from one never run.
test('gg doctor --probe prints a passed line naming each probe that passed', async (t) => {
  caseEnv.caseEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-case-token' });
  onlyOnPath(t, GG_FILE);
  const { text } = await doctorOverCli({}, { probe: true });
  const passed = text.split('\n').filter((line) => line.startsWith('passed: harness claude: '));
  for (const probe of ['profile-probe', 'handoff-probe', 'fork-probe'])
    assert.equal(passed.filter((line) => line.startsWith(`passed: harness claude: ${probe}: `)).length, 1, text);
});
