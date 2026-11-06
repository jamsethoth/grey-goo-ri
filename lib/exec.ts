import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as containment from './containment.ts';
import * as commandCleanup from './command-cleanup.ts';
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

// shortcut: no shell, so Windows needs real .exe binaries on PATH (the Agent CLIs, gh and git all ship them);
// npm .cmd shims would need cross-spawn.
export function run(
  command: string,
  args: string[],
  { cwd, input, allowFail = false, inherit = false, timeoutMs, env }: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

// What a timed-out command's output ends with: the timeout, each process left alive, and any cleanup that failed.
const timeoutNote = (timeoutMs: number, { survivors, cleanupErrors }: commandCleanup.Cleanup) =>
  `\n[gg: timed out after ${timeoutMs} ms]` +
  survivors.map((survivor) => `\n[gg: could not kill pid ${survivor.pid}: ${survivor.error}]`).join('') +
  (cleanupErrors.length ? `\n[gg: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');

// Windows: terminate the job and wait until it is empty. A job not confirmed empty keeps gg's handle, so kill-on-close
// takes what is left when gg exits.
async function terminateJob(job: containment.Job, rootPid: number): Promise<commandCleanup.Cleanup> {
  let refused: string | undefined;
  try {
    job.terminate();
  } catch (err) {
    refused = (err as Error).message;
  }
  const cleanupErrors = refused ? [refused] : [];
  try {
    if (refused) {
      const survivors = job.members().map((pid) => ({ pid, error: `termination refused: ${refused}` }));
      return { survivors, cleanupErrors };
    }
    await job.emptied();
    job.close();
    return { survivors: [], cleanupErrors };
  } catch (err) {
    cleanupErrors.push(`could not verify the job is empty: ${(err as Error).message}`);
    return { survivors: [{ pid: rootPid, error: 'not verified gone' }], cleanupErrors };
  }
}

// Windows without a job: taskkill /T takes down what is still linked to the shell; orphans cannot be found. The linked
// descendants are listed first, while the links exist, to be named if taskkill is refused. taskkill is let finish:
// stopped partway on a loaded machine it can kill the shell but not the children it then no longer finds. The
// taskkillCommand seam gets the pid as its last argument.
async function takeDownTree(
  rootPid: number,
  kernel32: containment.Kernel32 | null,
  taskkillCommand: processTree.CommandLine | undefined,
  containmentError: string | undefined,
): Promise<commandCleanup.Cleanup> {
  const cleanupErrors = [containmentError] as string[];
  let linked: number[] = [];
  try {
    if (kernel32) linked = containment.linkedDescendants(kernel32, rootPid);
  } catch (err) {
    cleanupErrors.push(
      `could not list the command's descendants (${(err as Error).message}); they are not verified gone`,
    );
  }
  const [command, args] = taskkillCommand ?? [`${containment.SYSTEM32}\\taskkill.exe`, ['/T', '/F', '/PID']];
  const result = await processTree.runHelper([command, [...args, String(rootPid)]]);
  if (result.code === 0 || result.code === 128) return { survivors: [], cleanupErrors }; // 128: already gone
  cleanupErrors.push(
    `taskkill on command pid ${rootPid} failed: exit ${result.code}: ${(result.stderr || result.stdout).trim()}`,
  );
  const survivors = [rootPid, ...linked.filter(processTree.isAlive)].map((pid) => ({
    pid,
    error: 'still running after cleanup',
  }));
  return { survivors, cleanupErrors };
}

// How a shell command was held: in a job (Windows: the command and all it starts), or not, with containmentError saying
// why when a Windows command runs uncontained.
export type Containment = { containment: 'job' } | { containment: 'none'; containmentError?: string };

// A shell command's run: its exit code and combined output. A timed-out run has timedOut, survivors and cleanupErrors;
// a job's run that left processes behind names them in leftovers.
export type ShellResult = {
  code: number | null;
  output: string;
  timedOut?: true;
  survivors?: commandCleanup.Survivor[];
  cleanupErrors?: string[];
  leftovers?: number[];
} & Containment;

export interface Timers {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

export interface TestHooks {
  signal?: AbortSignal;
  killPid?: (pid: number) => void;
  snapshotCommand?: processTree.CommandLine;
  taskkillCommand?: processTree.CommandLine;
  timers?: Timers;
  onWatch?: (seen: commandCleanup.Seen) => void;
}

export interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
  testHooks?: TestHooks;
}

// run and runShell over kernel32, the FFI bin/gg.ts opens and passes down (ADR 0019); null runs Windows commands
// uncontained. Given nothing, it opens the real one.
export function createExec({ kernel32 = containment.openKernel32() }: { kernel32?: containment.Kernel32 | null } = {}) {
  return {
    run,
    runShell: (commandLine: string, options?: ShellOptions) => shell(kernel32, commandLine, options),
  };
}

// The process runner the entry point builds and passes down as `exec` (ADR 0019).
export type Exec = ReturnType<typeof createExec>;

// Run a repo-declared command line (e.g. "npm test") through the platform shell. timeoutMs bounds the command from the
// call, or from when testHooks.signal aborts.
// The result names its containment: job (Windows: the command and all it starts held in a job object) or none, with
// containmentError saying why when a Windows command runs uncontained. On timeout it resolves with timedOut: true,
// survivors: [{ pid, error }] for processes that could not be killed or confirmed gone, and cleanupErrors. A command
// that finishes but leaves processes behind is left alone and reported as leftovers: [pid] (job only; shortcut: POSIX
// does not report them).
// testHooks are a test's alone: snapshotCommand and taskkillCommand ([cmd, args]) replace the process listing / the
// tree kill, which gets the pid appended, and killPid the POSIX kill. With a signal, timeoutMs counts from when it
// aborts (from the call if it already has), so a case times the command out only once the processes it checks exist,
// however slowly they start. timers ({ setTimeout, clearTimeout }) run the timeout clock. onWatch gets the POSIX
// watcher's map of the descendants it has listed, keyed by pid, which it fills as it goes.
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

// A timed-out command taken down: its job terminated, its Windows tree killed by taskkill, or its POSIX tree killed.
function takeDown(
  { child, job, containmentError }: containment.Started,
  kernel32: containment.Kernel32 | null,
  watcher: processTree.Watcher | null,
  testHooks: TestHooks,
) {
  const { killPid = (pid: number) => process.kill(pid, 'SIGKILL'), snapshotCommand, taskkillCommand } = testHooks;
  // The pid is unset only when spawn fails, which 'error' reports before a timeout can fire.
  const pid = child.pid as number;
  if (job) return terminateJob(job, pid);
  if (process.platform === 'win32') return takeDownTree(pid, kernel32, taskkillCommand, containmentError);
  return processTree.killTree(pid, (watcher as processTree.Watcher).seen, killPid, snapshotCommand);
}

// The job's command exited: what it left running is named and let run on, and the output is read to its end.
async function settleJob(job: containment.Job, child: ChildProcess, closed: Promise<unknown>) {
  let leftovers: number[] = [];
  try {
    leftovers = job.leftovers(child.pid as number);
  } catch {} // an unreadable job names no leftovers, as a plain spawn names none
  let kept: string | undefined;
  try {
    job.release();
  } catch (err) {
    kept = (err as Error).message; // gg keeps the handle, so kill-on-close takes the leftovers when gg exits
    if (!leftovers.length) job.close();
  }
  // With no leftover every writer is gone, so the pipes close once read to the end.
  // shortcut: output a leftover holds unread at the exit is cut; #118 kills leftovers, and then the pipes close.
  await (leftovers.length ? new Promise((wake) => setImmediate(wake)) : closed);
  for (const pipe of pipesOf(child)) pipe.destroy();
  const note = leftovers.length
    ? `\n[gg: command finished but left running: pid ${leftovers.join(', ')}]` +
      (kept ? `\n[gg: they end when gg exits: the job could not let them run on (${kept})]` : '')
    : '';
  return { leftovers, note };
}

const containmentOf = ({ job, containmentError }: containment.Started): Containment =>
  job ? { containment: 'job' } : { containment: 'none', ...(containmentError && { containmentError }) };

function shell(
  kernel32: containment.Kernel32 | null,
  commandLine: string,
  { cwd, timeoutMs, testHooks = {} }: ShellOptions = {},
): Promise<ShellResult> {
  const { signal, timers = globalThis, onWatch } = testHooks;
  const { setTimeout: startTimer, clearTimeout: stopTimer } = timers;
  const started = startCommand(kernel32, commandLine, cwd);
  const { child, job } = started;
  const kind = containmentOf(started);
  return new Promise((resolve, reject) => {
    let output = '';
    for (const pipe of pipesOf(child)) pipe.setEncoding('utf8').on('data', (data: string) => (output += data));
    const closed = new Promise((settle) => child.on('close', settle));
    let timedOut = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = timeoutMs && process.platform !== 'win32' ? processTree.watchDescendants(child.pid!) : null;
    if (watcher) onWatch?.(watcher.seen);
    const onTimeout = async () => {
      timedOut = true; // the kill makes 'exit' and 'close' fire first; the timeout result below wins
      watcher?.stop();
      const cleanup = await takeDown(started, kernel32, watcher, testHooks);
      for (const pipe of pipesOf(child)) pipe.destroy(); // orphans may still hold the pipes
      const note = timeoutNote(timeoutMs as number, cleanup);
      resolve({ code: null, output: output + note, timedOut: true, ...cleanup, ...kind });
    };
    const arm = () => {
      if (!finished) timer = startTimer(onTimeout, timeoutMs);
    };
    if (timeoutMs) {
      if (!signal || signal.aborted) arm();
      else signal.addEventListener('abort', arm, { once: true });
    }
    const end = () => {
      finished = true;
      stopTimer(timer);
      watcher?.stop();
    };
    child.on('error', (err) => {
      end();
      reject(err);
    });
    if (!job) {
      child.on('close', (code: number | null) => {
        if (timedOut) return;
        end();
        resolve({ code, output, ...kind });
      });
      return;
    }
    // 'exit', not 'close': a leftover process can hold the pipes open for as long as it runs
    child.on('exit', async (code: number | null) => {
      if (timedOut) return;
      end();
      const { leftovers, note } = await settleJob(job, child, closed);
      resolve({ code, output: output + note, ...(leftovers.length ? { leftovers } : {}), ...kind });
    });
  });
}
