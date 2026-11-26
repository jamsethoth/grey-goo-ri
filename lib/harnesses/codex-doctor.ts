// gg doctor's checks of the Codex CLI (#484, ADR 0028), for lib/harnesses/codex.ts alone: the cheap checks gg doctor
// and gg run preflight run, which start no model call, in gg's CODEX_HOME, and the model probes only gg doctor --probe
// adds: the launch profile on a cheap call, and codex exec resume with --output-schema.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as exec from '../exec.ts';
import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';
import * as cliDoctor from './cli-doctor.ts';
import type * as codex from './codex.ts';

// The version #479's recordings came from.
export const MINIMUM_VERSION = '0.171.0';

// The line the sandbox check's command prints once it ran under MXC: a command can exit 0 without running (Q2 A).
export const MXC_MARKER = 'GG-MXC-PROBE';
// One trivial command under MXC, with no model call (Q2 A).
export const SANDBOX_ARGS = [
  'sandbox',
  '-c',
  'windows.sandbox="mxc"',
  '--',
  'powershell.exe',
  '-NoProfile',
  '-Command',
  `Write-Output ${MXC_MARKER}`,
];

const PROBE_BRIEF = 'Without any tool, answer with the word ok.';
const RESUME_BRIEF = 'Without any tool, answer with the word you answered before.';
// No model is named, so the call runs on the one gg's CODEX_HOME defaults to.
const PROBE_AGENT: model.Agent = {
  harness: 'codex',
  persona: 'probe.md',
  model: null,
  effort: 'low',
  access: 'read-only',
};
const PROBE_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

// The launch profile's argv, environment and files for a probe's call (codex.ts builds it).
export type ProfileLaunch = (call: codex.CodexCall) => Promise<codex.Launch>;

type Runner = Pick<exec.Exec, 'launch'>;
type Check = runContext.DoctorCheck;

// Codex prints its login state and a configuration error on stderr, which said reads after stdout's lines.
const withStderr = (runner: Runner): Runner => ({
  launch: async (options) => {
    const ended = await runner.launch(options);
    for (const line of ended.stderrTail.split(/\r?\n/).filter(Boolean)) options.onLine?.(line);
    return ended;
  },
});

// Every command runs in gg's CODEX_HOME (Q8 A of #481); a model call is named by exec, a cheap command by its argv.
const said = (runner: Runner, home: string, args: string[], more: Partial<exec.LaunchOptions> = {}) =>
  cliDoctor.said(withStderr(runner), {
    ...more,
    command: 'codex',
    args,
    env: { CODEX_HOME: home, ...more.env },
    ...(args[0] === 'exec' ? { name: 'codex exec' } : {}),
  });

// codex --version prints `codex-cli <version>`.
const versionCheck = (ran: cliDoctor.Said): Check =>
  cliDoctor.versionCheck(
    { ...ran, lines: ran.lines.map((line) => line.replace(/^codex-cli /, '')) },
    { command: 'codex', minimum: MINIMUM_VERSION, update: 'the installer Codex came from' },
  );

// codex login status says "Logged in using ..." or "Not logged in" (docs/research/codex-cli.md).
function loginCheck(ran: cliDoctor.Said, home: string): Check {
  const text = ran.lines.join('\n');
  const loggedIn = /^(?:Not logged in|Logged in)/m.exec(text)?.[0].startsWith('Logged') ?? null;
  return cliDoctor.loginCheck(ran, {
    command: `codex in gg's CODEX_HOME ${home}`,
    loggedIn,
    unreadable: `codex login status printed ${JSON.stringify(text)}`,
    login: `codex login with CODEX_HOME=${home}`,
  });
}

function sandboxCheck(ran: cliDoctor.Said): Check {
  if (ran.lines.includes(MXC_MARKER)) return cliDoctor.passed('sandbox', 'codex sandbox ran a command under MXC');
  const reason = cliDoctor.reasonOf(ran);
  return cliDoctor.failed(
    'sandbox',
    `codex sandbox did not run a command under MXC: it printed no ${MXC_MARKER} line but ` +
      `${JSON.stringify(ran.lines.join('\n'))}${reason === null ? '' : ` (${reason})`}`,
  );
}

// Codex starts the Agents' commands in PowerShell 7; a Store one passes, as Codex's commands stay in gg's job (Q3 A).
function shellCheck(): Check {
  const shell = cliDoctor.findShell('pwsh.exe');
  return shell
    ? cliDoctor.passed('shell', `pwsh is on PATH at ${shell.path}`)
    : cliDoctor.failed('shell', "pwsh (PowerShell 7) is not on PATH, and Codex runs the Agents' commands in it");
}

// What a model call's --json stream says: its thread, whether its turn completed, why it failed, and its last message.
function streamOf(lines: string[]) {
  const sent = cliDoctor.objectLines(lines);
  const threadId = sent.find((line) => line.type === 'thread.started')?.thread_id;
  const failedTurn = sent.findLast((line) => line.type === 'turn.failed')?.error;
  const lastError = sent.findLast((line) => line.type === 'error')?.message;
  const item = sent.findLast(
    (line) =>
      line.type === 'item.completed' && referencePaths.isRecord(line.item) && line.item.type === 'agent_message',
  )?.item;
  const text = referencePaths.isRecord(item) ? item.text : undefined;
  let response: unknown;
  try {
    response = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    response = undefined;
  }
  return {
    threadId: typeof threadId === 'string' ? threadId : null,
    completed: sent.some((line) => line.type === 'turn.completed'),
    failure: referencePaths.isRecord(failedTurn) ? failedTurn.message : lastError,
    answer: referencePaths.isRecord(response) ? response.answer : undefined,
  };
}

// A probe's call passed when its turn completed with an answer in the output schema.
function probeCheck(name: string, what: string, ran: cliDoctor.Said, passed: string): Check {
  const stream = streamOf(ran.lines);
  const problem = ran.failure ?? (stream.completed ? null : (stream.failure ?? ran.exited ?? 'no turn completed'));
  if (problem !== null) return cliDoctor.failed(name, `${what} failed: ${String(problem)}`);
  if (typeof stream.answer !== 'string') return cliDoctor.failed(name, `${what} sent no answer in its output schema`);
  return cliDoctor.passed(name, passed);
}

const probes = (runner: Runner, home: string, profile: ProfileLaunch) =>
  cliDoctor.inTemporary('gg-codex-probe-', async (directory) => {
    const cwd = join(directory, 'repo');
    // shortcut: exec starts only inside a git repository, which Codex finds by a .git above the cwd, so an empty one
    // stands in for git init; run git init should Codex read the repository.
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const launch = async (call: codex.CodexCall, input: string) => {
      const launched = await profile(call);
      for (const [path, text] of Object.entries(launched.files)) writeFileSync(path, text);
      return said(runner, home, launched.argv, { cwd, env: launched.env, input, wallMs: cliDoctor.PROBE_WALL_MS });
    };
    const call = { agent: PROBE_AGENT, schema: PROBE_SCHEMA, cwd, runDirectory: directory, access: 'read-only' };
    let ran: cliDoctor.Said;
    try {
      ran = await launch({ ...call, marker: 'profile-probe', resume: null }, PROBE_BRIEF);
    } catch (err) {
      // The profile launches over the listing, whose failure is the probe's and leaves the cheap checks standing.
      return [
        cliDoctor.failed('profile-probe', `the launch profile's call could not start: ${(err as Error).message}`),
      ];
    }
    const profileChecked = probeCheck(
      'profile-probe',
      "the launch profile's call",
      ran,
      'the launch profile answered under MXC in its output schema',
    );
    const { threadId } = streamOf(ran.lines);
    if (!profileChecked.ok) return [profileChecked];
    if (threadId === null)
      return [
        profileChecked,
        cliDoctor.failed('resume-probe', "the launch profile's call named no thread, so there is none to resume"),
      ];
    const resumed = await launch({ ...call, marker: 'resume-probe', resume: threadId }, RESUME_BRIEF);
    const resumedThread = streamOf(resumed.lines).threadId;
    const checked = probeCheck(
      'resume-probe',
      'codex exec resume',
      resumed,
      `codex exec resume continued thread ${threadId} in its output schema`,
    );
    const ranInstead = resumedThread === null ? 'named no thread' : `ran thread ${resumedThread} instead`;
    return [
      profileChecked,
      !checked.ok || resumedThread === threadId
        ? checked
        : cliDoctor.failed('resume-probe', `codex exec resume ${threadId} ${ranInstead}`),
    ];
  });

// The cheap checks, then under probe the model probes. A CLI that cannot start is the one failure: the checks that
// read what it prints do not run.
export async function doctor(
  runner: Runner,
  { probe }: runContext.DoctorOptions,
  { home, profile }: { home: string; profile: ProfileLaunch },
): Promise<runContext.DoctorReport> {
  const onWindows = process.platform === 'win32';
  const checks = onWindows ? [shellCheck()] : [];
  const version = await said(runner, home, ['--version']);
  if (!version.started) checks.push(cliDoctor.failed('executable', `codex cannot start: ${version.failure}`));
  else {
    const [login, sandbox] = await Promise.all([
      said(runner, home, ['login', 'status']),
      onWindows ? said(runner, home, SANDBOX_ARGS) : null,
    ]);
    checks.push(cliDoctor.passed('executable', 'codex starts'), versionCheck(version), loginCheck(login, home));
    if (sandbox) checks.push(sandboxCheck(sandbox));
    if (probe) checks.push(...(await probes(runner, home, profile)));
  }
  return { ok: checks.every(({ ok, severity }) => ok || severity === 'warning'), checks };
}
