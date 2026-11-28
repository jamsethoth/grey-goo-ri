// An Agent CLI replayed from its recordings, for any Harness's tests (#480): `replayLaunch`, a launch double that
// answers each argv in-process, a small test's stand-in for the CLI; and `fakeCli`, gg's real launch with the command
// it starts replaced by node running the fake CLI (child-scripts/fake-cli.ts), which replays a recorded call at each
// model call: the same one, or the next of several a case names. What a Harness's CLI answers, where its transcript
// goes and what its environment holds are that Harness's support module's. fakeCli spawns, so only medium tests call
// it.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as containmentProbe from '../../lib/containment-probe.ts';
import * as exec from '../../lib/exec.ts';
import * as processProbe from './process-probe.ts';
import * as tempDirectory from './temp-directory.ts';

// What the CLI printed for a command, on stdout and on stderr, and its exit code, as a recording keeps it.
export interface Answer {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

// A command that is no model call, with the answer the CLI gives it.
export interface RecordedCommand extends Answer {
  argv: string[];
}

// How a case changes the launch beside the answer: an executable that cannot start, and the first argument of a
// command that times out printing nothing, that exits 1 printing nothing, or that a signal ends printing nothing
// (code null, as on POSIX); and whether the containment probe's command leaves its child outside gg's job, as a Store
// pwsh's does (#533).
export interface LaunchState {
  missing?: boolean;
  hangs?: string;
  fails?: string;
  killed?: string;
  escapes?: boolean;
}

// The pid the containment probe's command prints in a case: its child's, in gg's job unless the case `escapes`.
export const PROBED_CHILD_PID = 4242;
const probedChild =
  ({ escapes = false }: LaunchState) =>
  (): containmentProbe.ChildInJob => ({
    lines: [String(PROBED_CHILD_PID)],
    pid: PROBED_CHILD_PID,
    inJob: !escapes,
    failure: null,
  });

// A launch that answers each argv in-process with `answer`, and every launch it was asked for; and the containment
// probe (exec's childInJob), answered by `probed`, and every probe it was asked for.
export function replayLaunch(
  answer: (args: readonly string[]) => Answer,
  state: LaunchState = {},
  probed: (options: containmentProbe.ChildInJobOptions) => containmentProbe.ChildInJob = probedChild(state),
) {
  const probes: containmentProbe.ChildInJobOptions[] = [];
  const childInJob = async (options: containmentProbe.ChildInJobOptions): Promise<containmentProbe.ChildInJob> => {
    probes.push(options);
    await Promise.resolve();
    return probed(options);
  };
  const launches: exec.LaunchOptions[] = [];
  const launch = async (options: exec.LaunchOptions): Promise<exec.LaunchResult> => {
    launches.push(options);
    if (state.missing) throw Object.assign(new Error(`spawn ${options.command} ENOENT`), { code: 'ENOENT' });
    options.onStarted?.({ kind: 'none' });
    const cleanup = { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' as const } };
    const ended = { signal: null, timedOut: null, cancelled: false, stderrTail: '', cleanup };
    const first = options.args[0];
    if (state.hangs !== undefined && state.hangs === first) return { ...ended, code: null, timedOut: 'wall' };
    if (state.fails !== undefined && state.fails === first) return { ...ended, code: 1 };
    if (state.killed !== undefined && state.killed === first) return { ...ended, code: null, signal: 'SIGKILL' };
    const { stdout, stderr = '', exitCode } = answer(options.args);
    const lines = stdout.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) options.onLine?.(line);
    return { ...ended, code: exitCode, stderrTail: stderr };
  };
  return { launch, launches, childInJob, probes };
}

// Where a model call's transcript goes and the file copied there, from the launch, the recording it replays (its path
// with no extension, as copied into the fake's directory) and the CLI's home directory; null writes none.
export type TranscriptOf = (call: {
  launched: exec.LaunchOptions;
  recording: string;
  home: string;
}) => { path: string; from: string } | null;

export interface FakeCliOptions {
  // The directory holding each recording as <name>.json (its exit code and the files it changed) and <name>.jsonl.
  recordings: string;
  // The recording the fake replays; with several, each model call replays the next, and any after the last the last.
  scenario: string | string[];
  // The commands that are no model call, each answered as recorded; any other argv is a model call.
  commands?: RecordedCommand[];
  // The `type` of the line that carries the call's result, which `no-result`, `hang` and `signal` leave out.
  resultType: string;
  // How the fake changes the replay: `replay`, `no-result`, `garbage`, `hang`, `hang-no-transcript` or `signal`.
  mode?: string;
  transcript?: TranscriptOf;
  // The environment the CLI reads its home from, given that directory.
  env?: (home: string) => Record<string, string>;
  // Whether the fake leaves an orphan descendant running, whose pid it writes to orphanPidFile; the call's stall and
  // wall clocks count from that write (#475).
  orphan?: boolean;
  // The arguments of a helper the descendant is started under, a re-run of the CLI that writes its pid to helperPidFile
  // (and its exit to helperExitFile if it ends by itself) and stays while the descendant runs, as a CLI's sandbox
  // helper stays while the command it started runs (#483 Q1 A); none starts it through a middle process that exits.
  helper?: string[];
  // What the fake writes to its stderr.
  stderr?: string;
  // The executable launched in place of the CLI, node unless a case names one that does not exist.
  command?: string;
  // Whether each launch checks that every absolute path it carries holds a space (#426).
  spaced?: boolean;
}

// A received model call: its argv after the executable, and its stdin.
export interface Received {
  argv: string[];
  stdin: string | null;
}

const FAKE_CLI = fileURLToPath(new URL('./child-scripts/fake-cli.ts', import.meta.url));
const { launch: realLaunch } = exec.createExec();

const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

// Every absolute path a launch carries whole as its working directory, an argv entry or an environment value, the
// Harness's and the fake's, holds a space (#426); a path inside a flag value, JSON or a file is not checked. The
// command is node, the CLI's stand-in.
function assertSpaced(launched: exec.LaunchOptions) {
  for (const carried of [launched.cwd ?? '', ...launched.args, ...Object.values(launched.env ?? {})])
    assert.ok(!isAbsolute(carried) || carried.includes(' '), `the path ${carried} a CLI call carries holds no space`);
}

// The recordings the fake replays, copied into `directory`, one each model call in turn and the last after them; and
// what the fake received at each model call, its argv after the executable and its stdin, a file each.
function replaysIn(directory: string, recordings: string, scenarios: string[]) {
  const copies = scenarios.map((scenario, index) => {
    const copy = join(directory, `the recording ${index}`);
    for (const extension of ['.json', '.jsonl']) copyFileSync(join(recordings, scenario + extension), copy + extension);
    return copy;
  });
  const replayedAt = (call: number) => Math.min(call, scenarios.length - 1);
  const receivedFile = (call: number) => join(directory, `received ${call}.json`);
  // Nothing when the fake never ran.
  const receivedAt = (call: number): Received =>
    existsSync(receivedFile(call))
      ? (JSON.parse(readFileSync(receivedFile(call), 'utf8')) as { argv: string[]; stdin: string })
      : { argv: [], stdin: null };
  // Each of `count` model calls that reached the fake, in order, with the recording it replayed.
  const calls = (count: number) =>
    Array.from({ length: count }, (_unused, call) => ({
      recording: scenarios[replayedAt(call)]!,
      ...receivedAt(call),
    })).filter((made): made is { recording: string; argv: string[]; stdin: string } => made.stdin !== null);
  return { recordingAt: (call: number) => copies[replayedAt(call)]!, receivedFile, receivedAt, calls };
}

// What the fake's directory holds: the CLI's home, the repository a call runs in, the Run directory, and the pid file
// each process of the fake writes, the CLI's, the helper's and the descendant's, and the file the helper writes if it
// ends by itself.
const pathsIn = (directory: string) => ({
  home: join(directory, 'home'),
  cwd: join(directory, 'repo'),
  runDirectory: join(directory, 'run'),
  cliPidFile: join(directory, 'cli.pid'),
  helperPidFile: join(directory, 'helper.pid'),
  helperExitFile: join(directory, 'helper exited'),
  orphanPidFile: join(directory, 'orphan.pid'),
});

// What the fake's helper reads: its argv, and the files it writes its pid to and, ending by itself, its exit to.
const helperEnv = (helper: string[], { helperPidFile, helperExitFile }: ReturnType<typeof pathsIn>) => ({
  FAKE_CLI_HELPER: JSON.stringify(helper),
  FAKE_CLI_HELPER_PID: helperPidFile,
  FAKE_CLI_HELPER_EXIT: helperExitFile,
});

// The fake CLI in a temp directory holding the CLI's home, the repository a call runs in, the Run directory, and the
// fake's script and recordings, copied there; its launch, every launch it was asked for, and what the fake received.
export function fakeCli(t: TestContext, options: FakeCliOptions) {
  const { mode = 'replay', command = process.execPath, orphan = false, stderr, spaced = true, commands = [] } = options;
  // On Windows a fake just killed holds its working directory for a moment, so the repository goes first, with retries;
  // any process of the fake's left running, which a failed case can leave, is ended before it.
  const removeRepository = () => {
    for (const pidFile of [cliPidFile, helperPidFile, orphanPidFile]) processProbe.endProcessIn(pidFile);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  };
  const directory = tempDirectory.tempDirectory(t, 'gg fake cli-', undefined, removeRepository);
  const paths = pathsIn(directory);
  const { home, cwd, runDirectory, cliPidFile, helperPidFile, orphanPidFile } = paths;
  for (const made of [home, cwd, runDirectory]) mkdirSync(made);
  // .mts, so node runs the copy as a module whatever package.json lies above the temp directory
  const fakeScript = join(directory, 'fake cli.mts');
  copyFileSync(FAKE_CLI, fakeScript);
  const replays = replaysIn(directory, options.recordings, [options.scenario].flat());
  const commandsFile = join(directory, 'the commands.json');
  writeFileSync(commandsFile, JSON.stringify(commands));
  // What the Harness asked launch for, each call's options as it passed them.
  const launches: exec.LaunchOptions[] = [];
  const modelCalls = () => launches.filter(({ args }) => !commands.some(({ argv }) => sameArgv(argv, args))).length;
  const launch = (asked: exec.LaunchOptions) => {
    launches.push(asked);
    const call = Math.max(modelCalls() - 1, 0);
    const recording = replays.recordingAt(call);
    const transcript =
      mode === 'hang-no-transcript' ? null : options.transcript?.({ launched: asked, recording, home });
    const sentFile = join(directory, `call ${call} sent.pid`);
    const launched = {
      ...asked,
      ...clockHold(mode, { sent: sentFile, orphan: orphan ? orphanPidFile : null }, t.signal),
      command,
      args: [fakeScript, ...asked.args],
      env: {
        ...asked.env,
        ...options.env?.(home),
        FAKE_CLI_RECORDING: recording,
        FAKE_CLI_COMMANDS: commandsFile,
        FAKE_CLI_MODE: mode,
        FAKE_CLI_RESULT_TYPE: options.resultType,
        FAKE_CLI_RECEIVED: replays.receivedFile(call),
        FAKE_CLI_PID: cliPidFile,
        FAKE_CLI_SENT: sentFile,
        ...(transcript && { FAKE_CLI_TRANSCRIPT: transcript.path, FAKE_CLI_TRANSCRIPT_FROM: transcript.from }),
        ...(orphan && { FAKE_CLI_ORPHAN: orphanPidFile }),
        ...(options.helper && helperEnv(options.helper, paths)),
        ...(stderr !== undefined && { FAKE_CLI_STDERR: stderr }),
      },
    };
    if (spaced) assertSpaced(launched);
    return realLaunch(launched);
  };
  // What the fake read at the last model call, and at each.
  const received = () => replays.receivedAt(Math.max(modelCalls() - 1, 0));
  const calls = () => replays.calls(modelCalls());
  return { launch, launches, directory, received, calls, ...paths };
}

export type FakeCli = ReturnType<typeof fakeCli>;

// What launch's stall and wall clocks wait for, so no slow start of the fake beats them (#475): a hang's, until it has
// sent its lines; an orphan's, until the orphan has written its pid; else nothing.
function clockHold(mode: string, pidFiles: { sent: string; orphan: string | null }, signal: AbortSignal) {
  const held = mode.startsWith('hang') ? pidFiles.sent : pidFiles.orphan;
  return held === null ? {} : { testHooks: { signal: processProbe.pidWritten(held, signal) } };
}
