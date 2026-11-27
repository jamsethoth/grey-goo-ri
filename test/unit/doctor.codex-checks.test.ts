// gg doctor's checks of the Codex CLI (#484): over the Codex Harness shipped builds, its CLI answering in-process as
// recorded (test/fixtures/codex/), in cheap mode and under --probe. The sibling of doctor.cli-checks.test.ts, which
// holds Claude's.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as cliDoctor from '../../lib/harnesses/cli-doctor.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as recordCodexCommands from '../../scripts/record-codex-commands.ts';
import * as caseEnv from '../support/case-env.ts';
import * as codexHookHandlers from '../support/codex-hook-handlers.ts';
import * as exampleSource from '../support/example-source.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as recordedCodexCli from '../support/recorded-codex-cli.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const FAKE_HARNESS = fakeHarness.fakeHarness();
// A case that asks nobody reads no labels.
const DEPS = { gh: github.createGh(fakeGh.fakeGh({ branch: 'b', ticket: 1 }).gh), cwd: '/repo' };
const file = (bytes: string) => ({ bytes, hash: config.sha256(bytes) });
// MXC and the PowerShell the Agents' commands run in are Windows' (ADR 0025, ADR 0031).
const ON_WINDOWS = { skip: process.platform !== 'win32' && 'Windows only: MXC and pwsh are checked on win32' };
const ON_WIN32 = process.platform === 'win32';

// `repository` as the repository's source, beside a user source that holds only the machine settings; the files it
// names move beside it.
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

// The example Source with every Agent on the Codex Harness, as gg init --harness codex writes it.
function codexExample() {
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
  for (const agent of Object.values(source.agents)) agent.harness = 'codex';
  return source;
}

interface MachineOptions {
  // The files PATH holds, in a folder of the case named `folder`: by default an unpackaged pwsh on win32.
  onPath?: string[];
  folder?: string;
}

// The machine a case runs on until it ends: GG_HOME a directory of the case's, so gg's Codex home is the case's, and
// PATH one folder holding only `onPath`. Gives the folder.
function machine(t: TestContext, { onPath = ON_WIN32 ? ['pwsh.exe'] : [], folder = 'bin' }: MachineOptions = {}) {
  const directory = tempDirectory.tempDirectory(t, 'gg-codex-doctor-');
  const pathFolder = join(directory, ...folder.split('/'));
  mkdirSync(pathFolder, { recursive: true });
  for (const name of onPath) writeFileSync(join(pathFolder, name), '');
  caseEnv.caseEnv(t, { GG_HOME: join(directory, 'gg-home'), PATH: pathFolder });
  return pathFolder;
}

// The Codex Harness's doctor over the CLI as recorded, changed by `state`, and every launch it asked for.
async function codexDoctor(
  t: TestContext,
  state: recordedCodexCli.CodexState = {},
  { probe = false, ...options }: MachineOptions & { probe?: boolean } = {},
) {
  machine(t, options);
  const cli = recordedCodexCli.recordedCodexCli(state);
  const report = await codex.createCli(cli).doctor({ probe, agents: {} });
  const named = (name: string) => report.checks.find((check) => check.name === name);
  return { ...report, named, launches: cli.launches, probes: cli.probes };
}

// gg doctor over the Harnesses shipped builds, the Codex CLI answering as recorded, and every launch it asked for.
async function doctorOverCodex(
  t: TestContext,
  state: recordedCodexCli.CodexState = {},
  { probe = false, ...options }: MachineOptions & { probe?: boolean } = {},
) {
  machine(t, options);
  const cli = recordedCodexCli.recordedCodexCli(state);
  const harnesses = { ...shipped.shipped(cli), fake: FAKE_HARNESS };
  const result = await doctor.doctor({ config: sources(codexExample()), ...DEPS, harnesses, probe });
  return { ...result, launches: cli.launches };
}

// Codex's doctor lines, the harness-doctor-failed errors and warnings naming codex.
const codexDoctorLines = (text: string, severity: 'error' | 'warning') =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${severity}: harness codex: `) && line.endsWith(' [harness-doctor-failed]'));
const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);
const isModelCall = (args: readonly string[]) => args[0] === 'exec';

test('a Codex older than the minimum fails the version check', async (t) => {
  const { named } = await codexDoctor(t, { version: recordedCodexCli.OLD_VERSION });
  const version = named('version');
  assert.equal(version?.ok, false, version?.message ?? 'no version check');
  assert.equal(version.severity, 'error');
  assert.ok(version.message.includes('0.170.0') && version.message.includes('0.171.0'), version.message);
});

// Decision 1: the login is gg's own Codex home's (Q8 A of #481), which codex login status reports on stderr.
test('a logged-out gg CODEX_HOME fails the login check', async (t) => {
  const { named, launches } = await codexDoctor(t, { loggedOut: true });
  const login = named('login');
  assert.equal(login?.ok, false, login?.message ?? 'no login check');
  assert.equal(login.severity, 'error');
  const [status] = launches.filter(({ args }) => sameArgv(args, ['login', 'status']));
  assert.equal(status?.env?.CODEX_HOME, codex.codexHome(), 'codex login status runs in gg CODEX_HOME');
});

// Q2 A: the sandbox command failing, as the recorded unknown sandbox value failed, fails the check, naming what Codex
// said.
test('a machine without mxc fails the sandbox check', ON_WINDOWS, async (t) => {
  const { named } = await codexDoctor(t, { sandbox: 'unavailable' });
  const sandbox = named('sandbox');
  assert.equal(sandbox?.ok, false, sandbox?.message ?? 'no sandbox check');
  assert.equal(sandbox.severity, 'error');
  assert.ok(sandbox.message.includes('unknown variant'), sandbox.message);
});

// Q2 A: the recorded cmd command exited 0 without running, so only the marker line shows the command ran under MXC.
test('the sandbox check fails when its command exits 0 without the marker line', ON_WINDOWS, async (t) => {
  const { named } = await codexDoctor(t, { sandbox: 'no-marker' });
  const sandbox = named('sandbox');
  assert.equal(sandbox?.ok, false, sandbox?.message ?? 'no sandbox check');
  assert.equal(sandbox.severity, 'error');
  assert.ok(sandbox.message.includes(recordedCodexCli.MXC_MARKER), sandbox.message);
});

// Q3 A: Codex's commands ran in gg's job though its first pwsh was the Store's (#479), so a packaged pwsh passes it.
test("a Store PowerShell 7 passes Codex's shell check", ON_WINDOWS, async (t) => {
  const { named } = await codexDoctor(t, {}, { folder: 'Microsoft/WindowsApps' });
  assert.equal(cliDoctor.findShell('pwsh.exe')?.packaged, true, 'the case puts the Store pwsh first on PATH');
  assert.equal(named('shell')?.ok, true, named('shell')?.message ?? 'no shell check');
});

// Q3 A: Codex fails only when PowerShell 7 is missing; Windows PowerShell alone does not pass it.
test("a machine with Windows PowerShell but no pwsh fails Codex's shell check", ON_WINDOWS, async (t) => {
  const { named } = await codexDoctor(t, {}, { onPath: ['powershell.exe'] });
  const shell = named('shell');
  assert.equal(shell?.ok, false, shell?.message ?? 'no shell check');
  assert.equal(shell.severity, 'error');
  assert.ok(shell.message.includes('pwsh'), shell.message);
});

// Q3 A: the one shell check both Harnesses call (#533) finds the first pwsh on PATH and says whether it is packaged.
test('the shared shell check finds the first pwsh on PATH and says whether it is packaged', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-shell-');
  const [store, unpackaged, empty] = [['Microsoft', 'WindowsApps'], ['PowerShell', '7'], ['empty']].map((parts) =>
    join(directory, ...parts),
  ) as [string, string, string];
  for (const folder of [store, unpackaged, empty]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(store, 'pwsh.exe'), '');
  writeFileSync(join(unpackaged, 'pwsh.exe'), '');
  assert.deepEqual(cliDoctor.findShell('pwsh.exe', [empty, store, unpackaged].join(delimiter)), {
    path: join(store, 'pwsh.exe'),
    packaged: true,
  });
  assert.deepEqual(cliDoctor.findShell('pwsh.exe', [unpackaged, store].join(delimiter)), {
    path: join(unpackaged, 'pwsh.exe'),
    packaged: false,
  });
  assert.equal(cliDoctor.findShell('pwsh.exe', empty), null);
});

test('the Codex doctor passes every cheap check of the recorded CLI', async (t) => {
  const { ok, checks } = await codexDoctor(t);
  assert.deepEqual(checks.map(({ name, ok: passed }) => [name, passed]).toSorted(), [
    ['executable', true],
    ['login', true],
    ...(ON_WIN32 ? [['sandbox', true]] : []),
    ...(ON_WIN32 ? [['shell', true]] : []),
    ['version', true],
  ]);
  assert.equal(ok, true);
});

// DoD 3: every command cheap mode starts runs in gg's Codex home and has a recorded answer.
test("every cheap command the Codex doctor starts runs in gg's CODEX_HOME and is recorded", async (t) => {
  const { launches } = await codexDoctor(t);
  assert.deepEqual(
    launches.map(({ args }) => args.join(' ')).toSorted(),
    recordedCodexCli.CHEAP_ARGVS.map((argv) => argv.join(' ')).toSorted(),
  );
  for (const { args, env } of launches) {
    assert.equal(env?.CODEX_HOME, codex.codexHome(), `codex ${args.join(' ')} runs in gg's CODEX_HOME`);
    assert.ok(recordedCodexCli.isRecorded(args), `codex ${args.join(' ')} has a recording in test/fixtures/codex/`);
  }
});

// D3 A of #484: each cheap command's recording was made from the recorder's one entry for it in gg's CODEX_HOME, with
// the argv the doctor starts, so a re-record records what the doctor runs.
test('each cheap command the Codex doctor starts is recorded from its recorder entry, argv for argv', async (t) => {
  const { launches } = await codexDoctor(t);
  for (const { args } of launches) {
    const entries = recordCodexCommands.COMMANDS.filter(
      ({ argv, home = 'gg', profile, trusted }) => home === 'gg' && !profile && !trusted && sameArgv(argv, args),
    );
    assert.equal(entries.length, 1, `the recorder lists codex ${args.join(' ')} once in gg's CODEX_HOME`);
    assert.deepEqual(recordedCodexCli.recordedCommand(entries[0]!.name).argv, args, `${entries[0]!.name}'s argv`);
  }
});

// Each state of the CLI and the machine a cheap check fails in, by the check that fails.
const FAILING: [string, recordedCodexCli.CodexState, MachineOptions][] = [
  ['executable', { missing: true }, {}],
  ['version', { version: recordedCodexCli.OLD_VERSION }, {}],
  ['login', { loggedOut: true }, {}],
  ...(ON_WIN32
    ? ([
        ['sandbox', { sandbox: 'unavailable' }, {}],
        ['sandbox', { sandbox: 'no-marker' }, {}],
        ['shell', {}, { onPath: ['powershell.exe'] }],
      ] as [string, recordedCodexCli.CodexState, MachineOptions][])
    : []),
];

// DoD 1 and 2: without --probe, in every state, every command Codex's doctor starts is a cheap one, none a model call,
// and each cheap one is started.
test('gg doctor without --probe makes no model call', async (t) => {
  const started: string[][] = [];
  for (const [, state, options] of [['passing', {}, {}] as const, ...FAILING])
    started.push(...(await doctorOverCodex(t, state, options)).launches.map(({ args }) => args));
  for (const args of started) {
    assert.ok(!isModelCall(args), `cheap mode started the model call codex ${args.join(' ')}`);
    assert.ok(
      recordedCodexCli.CHEAP_ARGVS.some((argv) => sameArgv(argv, args)),
      `cheap mode started codex ${args.join(' ')}`,
    );
  }
  for (const argv of recordedCodexCli.CHEAP_ARGVS)
    assert.ok(
      started.some((args) => sameArgv(args, argv)),
      `cheap mode checks the CLI with codex ${argv.join(' ')}`,
    );
});

// DoD 1: every cheap check the doctor makes has a failing state above, and each failing one is one
// harness-doctor-failed error naming the Harness and the check, as Claude's are.
test('each failing cheap check is one harness-doctor-failed error naming codex and the check', async (t) => {
  const { checks } = await codexDoctor(t);
  assert.deepEqual(
    [...new Set(checks.map(({ name }) => name))].toSorted(),
    [...new Set(FAILING.map(([check]) => check))].toSorted(),
    'every cheap check has a failing state',
  );
  for (const [check, state, options] of FAILING) {
    const { text } = await doctorOverCodex(t, state, options);
    const errors = codexDoctorLines(text, 'error');
    assert.equal(errors.length, 1, `${check}: ${text}`);
    assert.ok(errors[0]!.startsWith(`error: harness codex: ${check}: `), errors[0]);
  }
});

// Decision 2: gg doctor --probe runs the launch profile on a cheap call and codex exec resume with --output-schema,
// and prints each that passed; since #485 also the hand-off hook on the profile probe's call and a read-only fork.
test('gg doctor --probe runs each model probe and prints a passed line for each', async (t) => {
  const { text } = await doctorOverCodex(t, {}, { probe: true });
  const passed = text.split('\n').filter((line) => line.startsWith('passed: harness codex: '));
  for (const probe of ['profile-probe', 'handoff-probe', 'resume-probe', 'fork-probe'])
    assert.equal(passed.filter((line) => line.startsWith(`passed: harness codex: ${probe}: `)).length, 1, text);
  assert.deepEqual(codexDoctorLines(text, 'error'), [], text);
});

// The thread start.jsonl, the profile probe's recording, started.
const RECORDED_THREAD = '01a2044a-1251-7180-8d49-dc1220e52393';

test("the resume probe resumes the profile probe's thread with --output-schema", async (t) => {
  const { launches } = await codexDoctor(t, {}, { probe: true });
  const calls = launches.filter(({ args }) => isModelCall(args) && !args.includes('fork'));
  assert.equal(calls.length, 2, JSON.stringify(calls.map(({ args }) => args)));
  const [profile, resumed] = calls as [(typeof calls)[number], (typeof calls)[number]];
  assert.ok(!profile.args.includes('resume'), JSON.stringify(profile.args));
  for (const flag of ['windows.sandbox="mxc"', '--output-schema', '--json'])
    assert.ok(profile.args.includes(flag), `the profile probe passes ${flag}`);
  assert.equal(profile.env?.CODEX_HOME, codex.codexHome());
  assert.equal(resumed.args[resumed.args.indexOf('resume') + 1], RECORDED_THREAD);
  assert.ok(resumed.args.includes('--output-schema'), JSON.stringify(resumed.args));
});

// #485 Q2 A: the profile probe's call runs as an Agent with a contextBudget its first request passes, so its hand-off
// hook asks for the hand-off; the hand-off stand-in answers as such a call does, since no recording shows one.
test('under --probe the profile probe carries the hand-off hook and the handoff probe passes', async (t) => {
  const { named, launches } = await codexDoctor(t, {}, { probe: true });
  const [profile] = launches.filter(({ args }) => isModelCall(args));
  assert.ok(profile !== undefined, 'the profile probe ran');
  assert.ok(!profile.args.includes('resume') && !profile.args.includes('fork'), JSON.stringify(profile.args));
  const passed = codexHookHandlers.overrides(profile.args);
  assert.ok(passed.includes('features.hooks=true'), JSON.stringify(profile.args));
  assert.ok(profile.args.includes('--dangerously-bypass-hook-trust'), JSON.stringify(profile.args));
  const handlers = codexHookHandlers.hookHandlers(profile.args);
  assert.deepEqual(
    handlers.map(({ event }) => event),
    ['PostToolUse'],
  );
  for (const command of [handlers[0]!.keys.command, handlers[0]!.keys.commandWindows])
    assert.ok(command?.includes('codex-handoff-hook'), `the hand-off hook, on both commands: ${command}`);
  const handoff = named('handoff-probe');
  assert.equal(handoff?.ok, true, handoff?.message ?? 'no handoff-probe check');
});

// #485 Q2 A: a hook that stays silent leaves the call answering as it would under its budget, which fails the probe.
test('a hand-off hook that stays silent fails the handoff probe', async (t) => {
  const { text } = await doctorOverCodex(t, { hookSilent: true }, { probe: true });
  const errors = codexDoctorLines(text, 'error');
  assert.equal(errors.length, 1, text);
  assert.ok(errors[0]!.startsWith('error: harness codex: handoff-probe: '), errors[0]);
});

// #485 Q2 A, as Claude's doctor asks one (#430 D6 A): gg ask-session's read-only fork of the profile probe's thread,
// `-s read-only` and `-C` before `fork` (#479 D18 A), answers under a thread of its own.
test("under --probe the fork probe asks a read-only fork of the profile probe's thread", async (t) => {
  const { named, launches } = await codexDoctor(t, {}, { probe: true });
  const forks = launches.filter(({ args }) => isModelCall(args) && args.includes('fork'));
  assert.equal(forks.length, 1, JSON.stringify(launches.map(({ args }) => args)));
  const [{ args, cwd, env }] = forks as [(typeof forks)[number]];
  const fork = args.indexOf('fork');
  assert.equal(args[fork + 1], RECORDED_THREAD);
  assert.ok(!args.includes('resume'), JSON.stringify(args));
  const before = args.slice(0, fork);
  assert.equal(before[before.indexOf('-s') + 1], 'read-only', JSON.stringify(args));
  assert.equal(before[before.indexOf('-C') + 1], cwd, JSON.stringify(args));
  assert.equal(env?.CODEX_HOME, codex.codexHome());
  const forked = named('fork-probe');
  assert.equal(forked?.ok, true, forked?.message ?? 'no fork-probe check');
});

test('a fork probe whose stream names no thread of its own fails', async (t) => {
  for (const state of [{ unthreaded: 'fork' }, { fork: 'start' }] as const) {
    const { named } = await codexDoctor(t, state, { probe: true });
    const forked = named('fork-probe');
    assert.equal(forked?.ok, false, `${JSON.stringify(state)}: ${forked?.message ?? 'no fork-probe check'}`);
    assert.equal(forked.severity, 'error');
  }
});

test('a failed profile probe is an error and runs no resume probe', async (t) => {
  const { named, launches } = await codexDoctor(t, { profile: 'auth-invalid' }, { probe: true });
  const profile = named('profile-probe');
  assert.equal(profile?.ok, false, profile?.message ?? 'no profile-probe check');
  assert.equal(profile.severity, 'error');
  assert.equal(named('resume-probe'), undefined);
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('resume')),
    [],
  );
});

// D17 A of #481: only the Agent's listing turns a configured server on, so the probes launch over a listing like the
// one each Run's call takes, which switches off each server the probe Agent does not list, and the plugins with it.
// The fork probe's call too (#485).
test('under --probe every probe call switches off each configured MCP server and the plugins', async (t) => {
  const { launches } = await codexDoctor(t, { servers: ['playwright'] }, { probe: true });
  const calls = launches.filter(({ args }) => isModelCall(args));
  assert.equal(calls.length, 3, JSON.stringify(calls.map(({ args }) => args)));
  for (const { args } of calls) {
    assert.ok(args.includes('mcp_servers={"playwright"={enabled=false}}'), JSON.stringify(args));
    assert.equal(args[args.indexOf('--disable') + 1], 'plugins', JSON.stringify(args));
  }
});

test('a listing that fails under --probe fails the profile probe, naming its command', async (t) => {
  const { named, launches } = await codexDoctor(t, { fails: 'mcp' }, { probe: true });
  const profile = named('profile-probe');
  assert.equal(profile?.ok, false, profile?.message ?? 'no profile-probe check');
  assert.equal(profile.severity, 'error');
  assert.ok(profile.message.includes('codex mcp list'), profile.message);
  assert.equal(named('version')?.ok, true, 'the cheap checks still report');
  assert.deepEqual(
    launches.filter(({ args }) => isModelCall(args)),
    [],
  );
});

// A resume probe needs the profile probe's thread, so a profile call that names none fails it instead of skipping it.
test('a profile probe whose stream names no thread fails the resume probe', async (t) => {
  const { named, launches } = await codexDoctor(t, { unthreaded: 'profile' }, { probe: true });
  const resume = named('resume-probe');
  assert.equal(resume?.ok, false, resume?.message ?? 'no resume-probe check');
  assert.equal(resume.severity, 'error');
  assert.deepEqual(
    launches.filter(({ args }) => args.includes('resume')),
    [],
  );
});

test('a probe whose answer is not in its output schema fails', async (t) => {
  for (const call of ['profile', 'resume'] as const) {
    const { named } = await codexDoctor(t, { prose: call }, { probe: true });
    const probe = named(`${call}-probe`);
    assert.equal(probe?.ok, false, probe?.message ?? `no ${call}-probe check`);
    assert.match(probe.message, /no answer in its output schema/);
  }
});

test('a resume probe whose stream names no thread fails', async (t) => {
  const { named } = await codexDoctor(t, { unthreaded: 'resume' }, { probe: true });
  const resume = named('resume-probe');
  assert.equal(resume?.ok, false, resume?.message ?? 'no resume-probe check');
  assert.equal(resume.severity, 'error');
});

// Q1 B of #533: Codex's containment probe runs as Codex runs the Agents' commands, through codex sandbox under MXC in
// gg's CODEX_HOME, in the first pwsh on PATH. #533's one real call shows a Store pwsh there leaving its child in gg's
// job, so a Store pwsh passes it (#484 Q3 A), replayed from that recording.
test(
  'under --probe, Codex runs the containment probe under MXC in the first pwsh on PATH, which a Store pwsh passes',
  ON_WINDOWS,
  async (t) => {
    const { named, probes } = await codexDoctor(t, {}, { probe: true, folder: 'Microsoft/WindowsApps' });
    const shell = cliDoctor.findShell('pwsh.exe');
    assert.equal(shell?.packaged, true, 'the case puts the Store pwsh first on PATH');
    const containment = named('containment-probe');
    assert.equal(containment?.ok, true, containment?.message ?? 'no containment-probe check');
    assert.equal(probes.length, 1, JSON.stringify(probes));
    const [probed] = probes as [(typeof probes)[number]];
    assert.equal(probed.command, 'codex');
    assert.deepEqual(probed.args.slice(0, 5), ['sandbox', '-c', 'windows.sandbox="mxc"', '--', shell.path]);
    assert.equal(probed.env?.CODEX_HOME, codex.codexHome());
  },
);

// ADR 0030 decision 6: a later Codex whose sandboxed command leaves its child outside gg's job fails the probe.
test(
  "under --probe, a Codex sandbox whose command's child is outside gg's job fails the containment probe",
  ON_WINDOWS,
  async (t) => {
    const { text } = await doctorOverCodex(t, { escapes: true }, { probe: true });
    const errors = codexDoctorLines(text, 'error');
    assert.equal(errors.length, 1, text);
    assert.ok(errors[0]!.startsWith('error: harness codex: containment-probe: '), errors[0]);
  },
);
