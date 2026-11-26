import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as commandShim from './command-shim.ts';
import * as containment from './containment.ts';
import * as commandCleanup from './command-cleanup.ts';
import * as launchClock from './launch-clock.ts';
import * as processTree from './process-tree.ts';

// What a finished process gave: its exit code (null when a signal or timeout ended it), stdout and stderr.
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  allowFail?: boolean;
  inherit?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

// A command that ran and exited nonzero, with its output, so a catch site can tell it from a spawn failure (a missing
// executable), which rejects with the plain error spawn gives.
export class CommandError extends Error {
  name = 'CommandError';
  code: number | null;
  stdout: string;
  stderr: string;

  constructor(message: string, { code, stdout, stderr }: CommandResult, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// A child spawned with piped stdio has both pipes.
const pipesOf = (child: ChildProcess) => [child.stdout, child.stderr] as [Readable, Readable];

export function run(
  command: string,
  args: string[],
  { cwd, input, allowFail = false, inherit = false, timeoutMs, env }: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const argv = commandShim.argvOf(command, args, { path: env?.PATH, cwd });
    const child = spawn(argv.command, argv.args, {
      cwd,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      const [stdoutPipe, stderrPipe] = pipesOf(child);
      stdoutPipe.setEncoding('utf8').on('data', (data: string) => (stdout += data));
      stderrPipe.setEncoding('utf8').on('data', (data: string) => (stderr += data));
      child.stdin?.on('error', () => {}); // child exited before reading all input: 'close' reports it
      child.stdin?.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      const result = { code, stdout, stderr };
      if (code !== 0 && !allowFail) {
        const shown = args
          .map((argument) => (argument.length > 200 ? `<${argument.length} chars>` : argument))
          .join(' ');
        reject(new CommandError(`${(stderr || stdout).trim()}\n${command} ${shown} exited ${code}`, result));
      } else resolve(result);
    });
  });
}

// What cleanup could not do, for a command's output: each process left alive, and any cleanup that failed.
const cleanupNote = ({ survivors, cleanupErrors }: commandCleanup.Cleanup) =>
  survivors.map((survivor) => `\n[gg: could not kill pid ${survivor.pid}: ${survivor.error}]`).join('') +
  (cleanupErrors.length ? `\n[gg: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');

// What a timed-out command's output ends with: the timeout, and what cleanup could not do.
const timeoutNote = (timeoutMs: number, cleanup: commandCleanup.Cleanup) =>
  `\n[gg: timed out after ${timeoutMs} ms]` + cleanupNote(cleanup);

// What a finished command's output ends with: what it left running, by name, and what cleanup could not do.
function finishedNote(cleanup: processTree.Settled) {
  const named = cleanup.leftovers.map(({ pid, commandLine }) => `pid ${pid}${commandLine ? ` (${commandLine})` : ''}`);
  const left = named.length ? `\n[gg: command finished but left running: ${named.join(', ')}]` : '';
  return left + cleanupNote(cleanup);
}

// How a shell command was held: in a job (Windows: the command and all it starts, a process started outside it adopted
// or ended by its watcher), or not, with containmentError saying why when a Windows command runs uncontained.
export type Containment = { containment: 'job' } | { containment: 'none'; containmentError?: string };

// A shell command's run: its exit code and combined output, and what its Command Cleanup found. A timed-out run has
// timedOut, survivors and cleanupErrors; a run that finished and left processes behind names them in leftovers.
export type ShellResult = {
  code: number | null;
  output: string;
  timedOut?: true;
  survivors?: commandCleanup.Survivor[];
  cleanupErrors?: string[];
  leftovers?: number[];
  cleanup: commandCleanup.CleanupReport;
} & Containment;

export interface Timers {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

export interface TestHooks extends processTree.CleanupHooks {
  signal?: AbortSignal;
  onExit?: () => void;
  timers?: Timers;
  onWatch?: (seen: commandCleanup.Seen) => void;
}

export interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
  testHooks?: TestHooks;
}

// What launch runs: an argv with no shell, contained, under a stall clock, a wall clock and the Run's cancel signal.
// onIdle answers when the stall clock runs out: the time (ms since the epoch) of the last activity the caller saw, from
// which the clock re-arms for what is left of stallMs, or null. testHooks are a test's alone: stall and wall count from
// when testHooks.signal aborts, as runShell's timeout does (#475).
export interface LaunchOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  stallMs?: number;
  wallMs?: number;
  signal?: AbortSignal;
  onStarted?: (containment: commandCleanup.CleanupContainment) => void;
  onLine?: (line: string) => void;
  onIdle?: () => number | null | Promise<number | null>;
  testHooks?: Pick<TestHooks, 'signal'>;
}

// What a launch ended with: how the process exited, which clock or the cancel stopped it, its stderr's end, and what
// its Command Cleanup found.
export interface LaunchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: 'stall' | 'wall' | null;
  cancelled: boolean;
  stderrTail: string;
  cleanup: commandCleanup.CleanupReport;
}

// How much of a launch's stderr it keeps: the end, where a CLI says why it stopped.
const STDERR_TAIL_CHARS = 16_384;

// An argv started with no shell, and when it started or why it could not: on Windows behind the gate in a job,
// elsewhere in its own process group. env is merged over gg's environment, as run's is.
function startArgv(kernel32: containment.Kernel32 | null, { command, args, cwd, env }: LaunchOptions) {
  const argv = commandShim.argvOf(command, args, { path: env?.PATH, cwd });
  const environment = env ? { ...process.env, ...env } : undefined;
  if (process.platform === 'win32') return containment.startArgv(kernel32, argv, { cwd, env: environment });
  const child = spawn(argv.command, argv.args, { cwd, env: environment, detached: true, stdio: 'pipe' });
  const spawned = new Promise<Error | null>((answer) => child.on('spawn', () => answer(null)).on('error', answer));
  return { child, job: null, spawned };
}

// Each whole line of a stream, without its line ending, and an unended last one at the stream's end.
function eachLine(stream: Readable, onLine: (line: string) => void) {
  let partial = '';
  stream.on('data', (data: string) => {
    const lines = (partial + data).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) onLine(line.replace(/\r$/, ''));
  });
  stream.on('end', () => partial && onLine(partial.replace(/\r$/, '')));
}

// Start an argv contained, with no shell; see LaunchOptions. Nothing is left running when it resolves: a stop takes the
// tree down, and an exit ends what the argv left, with what its watcher linked, as runShell does; cleanup says what it
// found. A launch whose executable cannot start rejects with the spawn error.
function launch(kernel32: containment.Kernel32 | null, options: LaunchOptions): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const started = startArgv(kernel32, options);
    const { child } = started;
    const cleanupContainment = cleanupContainmentOf(started);
    const watcher = processTree.watch(started, kernel32);
    const closed = new Promise((settled) => child.on('close', settled));
    const { promise: gaveUp, resolve: giveUp } = Promise.withResolvers<void>();
    let stopped: launchClock.Stop | null = null;
    let exited = false;
    let stderrTail = '';
    let reported = false; // onStarted once, before the result: a gate a stop left running may never answer
    const reportStarted = () => !reported && ((reported = true), options.onStarted?.(cleanupContainment));
    const finish = (ended: Pick<LaunchResult, 'code' | 'signal'>, cleanup: commandCleanup.Cleanup) => {
      clocks.stop();
      for (const pipe of pipesOf(child)) pipe.destroy();
      const timedOut = stopped === 'cancel' ? null : stopped;
      const report = reportOf(started, cleanupContainment, cleanup);
      resolve({ ...ended, timedOut, cancelled: stopped === 'cancel', stderrTail, cleanup: report });
    };
    // A clock or the cancel after the exit only stops the wait for pipes a process outside the containment holds.
    const clocks = launchClock.startClocks(options, async (why) => {
      if (exited) return giveUp();
      if (stopped || !child.pid) return; // no pid: the spawn failed, and its error rejects the launch
      stopped = why;
      watcher?.stop();
      const { survivors, cleanupErrors } = await processTree.takeDown(started, kernel32, watcher, {});
      if (survivors.length) reportStarted();
      else await started.spawned;
      finish({ code: null, signal: null }, { survivors, cleanupErrors });
    });
    const [stdoutPipe, stderrPipe] = pipesOf(child);
    stdoutPipe.setEncoding('utf8').on('data', clocks.touch);
    stderrPipe.setEncoding('utf8').on('data', (data: string) => {
      clocks.touch();
      stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
    });
    eachLine(stdoutPipe, (line) => options.onLine?.(line));
    child.stdin?.on('error', () => {}); // exited before reading all input: its exit reports it
    child.stdin?.end(options.input ?? '');
    void started.spawned.then(async (failure) => {
      // A stop that ended the gate before it answered resolves the launch; the containment still held what started.
      if (!failure || stopped) return reportStarted();
      clocks.stop();
      await watcher?.stop();
      reject(failure);
    });
    // 'exit', not 'close': a leftover process can hold the pipes open for as long as it runs
    child.on('exit', async (code: number | null, signal: NodeJS.Signals | null) => {
      if (stopped) return;
      exited = true;
      watcher?.stop();
      await started.spawned;
      const settled = await processTree.settle(started, kernel32, watcher, {});
      if (!(await Promise.race([closed.then(() => true), gaveUp.then(() => false)])))
        settled.cleanupErrors.push('its output pipes stayed open past its clocks, held by a process gg cannot find');
      finish({ code, signal }, settled);
    });
  });
}

// run, runShell and launch over kernel32, the FFI bin/gg.ts opens and passes down (ADR 0019); null runs Windows
// commands uncontained. Given nothing, it opens the real one.
export function createExec({ kernel32 = containment.openKernel32() }: { kernel32?: containment.Kernel32 | null } = {}) {
  return {
    run,
    runShell: (commandLine: string, options?: ShellOptions) => shell(kernel32, commandLine, options),
    launch: (options: LaunchOptions) => launch(kernel32, options),
    cleanupConfirmed,
  };
}

// Whether a later Run finds a held call's processes gone under the containment its cleanup recorded (L14).
export const cleanupConfirmed = (containment: commandCleanup.CleanupContainment | undefined): boolean =>
  commandCleanup.confirmedUnder(containment, processTree.groupHasMembers);

// The process runner the entry point builds and passes down as `exec` (ADR 0019).
export type Exec = ReturnType<typeof createExec>;

// Run a repo-declared command line (e.g. "npm test") through the platform shell. timeoutMs bounds the command from the
// call, or from when testHooks.signal aborts.
// The result names its containment: job (Windows: the command and all it starts held in a job object, or adopted or
// ended by its watcher) or none, with containmentError saying why. Nothing is left running when it answers, whether
// the command finished or timed out (L6): it ends its leftovers, waits for its output pipes to close, and says what it
// found in cleanup. On timeout it also resolves with timedOut: true, survivors: [{ pid, error }] for processes that
// could not be killed or confirmed gone, and cleanupErrors. A command that finishes names what it left as
// leftovers: [pid].
// testHooks are a test's alone: snapshotCommand and taskkillCommand ([cmd, args]) replace the process listing / the
// tree kill, which gets the pid appended, and killPid the POSIX kill. With a signal, timeoutMs counts from when it
// aborts (from the call if it already has), so a case times the command out only once the processes it checks exist,
// however slowly they start. timers ({ setTimeout, clearTimeout }) run the timeout clock. onWatch gets the POSIX
// watcher's map of the descendants it has listed, keyed by pid, which it fills as it goes. onExit is called when the
// command has exited, before its cleanup, so a case can start the clock that bounds the wait for its pipes.
export function runShell(commandLine: string, options?: ShellOptions) {
  return shell(realKernel32(), commandLine, options);
}

// The real kernel32 for runShell's callers that take no seam, opened on the first call rather than at import, so
// importing exec opens nothing beside what bin/gg.ts passes down.
const realKernel32 = (() => {
  let opened: { kernel32: containment.Kernel32 | null } | undefined;
  return () => (opened ??= { kernel32: containment.openKernel32() }).kernel32;
})();

// The command started: on Windows in a job when it can be, elsewhere through sh in its own process group.
function startCommand(kernel32: containment.Kernel32 | null, commandLine: string, cwd: string | undefined) {
  if (process.platform === 'win32') return containment.start(kernel32, commandLine, cwd);
  const child = spawn('sh', ['-c', commandLine], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, job: null } as containment.Started;
}

const containmentOf = ({ job, containmentError }: containment.Started): Containment =>
  job ? { containment: 'job' } : { containment: 'none', ...(containmentError && { containmentError }) };

// How gg can check later that the command's processes are gone (L14). exec's own containment says whether the command
// dies with gg, which a POSIX process group does not; this one says what there is to check, which it does give.
function cleanupContainmentOf({ child, job }: containment.Started): commandCleanup.CleanupContainment {
  if (job) return { kind: 'job' };
  return process.platform === 'win32' ? { kind: 'none' } : { kind: 'group', pgid: child.pid as number };
}

// A command's Command Cleanup report. An unconfirmed job keeps gg's handle, for the Run to close (closeJob).
function reportOf(
  started: containment.Started,
  cleanupContainment: commandCleanup.CleanupContainment,
  cleanup: commandCleanup.Cleanup,
) {
  const report = commandCleanup.cleanupReport(cleanupContainment, cleanup);
  if (started.job && !report.confirmed)
    Object.defineProperty(report, 'closeJob', { value: () => (started.job as containment.Job).close() });
  return report;
}

// The clock of a run: timeoutMs from the call, or from when signal aborts, unless the run stops it first.
function startClock(
  { timeoutMs, signal, timers = globalThis }: { timeoutMs?: number; signal?: AbortSignal; timers?: Timers },
  onTimeout: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (!stopped) timer = timers.setTimeout(onTimeout, timeoutMs);
  };
  if (timeoutMs) {
    if (!signal || signal.aborted) arm();
    else signal.addEventListener('abort', arm, { once: true });
  }
  return () => {
    stopped = true;
    timers.clearTimeout(timer);
  };
}

function shell(
  kernel32: containment.Kernel32 | null,
  commandLine: string,
  { cwd, timeoutMs, testHooks = {} }: ShellOptions = {},
): Promise<ShellResult> {
  const started = startCommand(kernel32, commandLine, cwd);
  const { child } = started;
  const kind = containmentOf(started);
  const cleanupContainment = cleanupContainmentOf(started);
  const resultOf = (cleanup: commandCleanup.Cleanup) => ({
    cleanup: reportOf(started, cleanupContainment, cleanup),
    ...kind,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    for (const pipe of pipesOf(child)) pipe.setEncoding('utf8').on('data', (data: string) => (output += data));
    const closed = new Promise((settled) => child.on('close', settled));
    let timedOut = false;
    let exited = false;
    // The clock also bounds the wait for a finished command's pipes, which a process cleanup cannot find may hold.
    let giveUp = () => {};
    const gaveUp = new Promise<void>((wake) => (giveUp = wake));
    const watcher = processTree.watch(started, kernel32);
    if (watcher && 'seen' in watcher) testHooks.onWatch?.(watcher.seen);
    const stopClock = startClock({ timeoutMs, signal: testHooks.signal, timers: testHooks.timers }, async () => {
      if (exited) return giveUp();
      timedOut = true; // the kill makes 'exit' and 'close' fire first; the timeout result below wins
      watcher?.stop();
      const { survivors, cleanupErrors } = await processTree.takeDown(started, kernel32, watcher, testHooks);
      for (const pipe of pipesOf(child)) pipe.destroy(); // orphans may still hold the pipes
      const taken = { survivors, cleanupErrors };
      const note = timeoutNote(timeoutMs as number, taken);
      resolve({ code: null, output: output + note, timedOut: true, ...taken, ...resultOf(taken) });
    });
    child.on('error', async (err) => {
      stopClock();
      await watcher?.stop();
      reject(err);
    });
    // 'exit', not 'close': a leftover process can hold the pipes open for as long as it runs
    child.on('exit', async (code: number | null) => {
      if (timedOut) return;
      exited = true;
      testHooks.onExit?.();
      watcher?.stop();
      const settled = await processTree.settle(started, kernel32, watcher, testHooks);
      // With no leftover alive every writer is gone, so the pipes close once read to the end, and a line that arrived
      // late is still read. A process that left the containment can hold them on; holding them is how it shows.
      if (!(await Promise.race([closed.then(() => true), gaveUp.then(() => false)])))
        settled.cleanupErrors.push('its output pipes stayed open until its timeout, held by a process gg cannot find');
      stopClock();
      for (const pipe of pipesOf(child)) pipe.destroy();
      const leftovers = settled.leftovers.map(({ pid }) => pid);
      const left = leftovers.length ? { leftovers } : {};
      resolve({ code, output: output + finishedNote(settled), ...left, ...resultOf(settled) });
    });
  });
}
