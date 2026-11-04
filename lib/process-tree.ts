import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as commandCleanup from './command-cleanup.ts';

// The processes a timed-out shell command leaves, found and killed as lib/command-cleanup.ts decides: the POSIX
// process listing, the watcher that follows a command's descendants, the tree kill, and the helper processes that list
// and kill them (exec.ts runs the command).

const POLL_GAP_MS = 250;

// A command and its arguments, as the test hooks replace a helper process with.
export type CommandLine = [command: string, args: string[]];

// Result of a helper process: { code, stdout, stderr }. Never rejects; code is null if it failed to start, outlived ms
// or was cancelled by signal. Without ms it is let finish, as taskkill /T must be: stopped partway on a loaded machine
// it can kill the shell but not the children it then no longer finds.
export function runHelper(
  [command, args]: CommandLine,
  ms?: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const helper = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const [stdoutPipe, stderrPipe] = [helper.stdout, helper.stderr] as [Readable, Readable];
    // let go of it as well as killing it: a helper that never exits would otherwise keep gg running through its handles
    const cancel = () => {
      helper.kill('SIGKILL');
      helper.unref();
      stdoutPipe.destroy();
      stderrPipe.destroy();
      done(null);
    };
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ code, stdout, stderr });
    };
    const timer = ms
      ? setTimeout(() => {
          helper.kill();
          done(null);
        }, ms)
      : undefined;
    signal?.addEventListener('abort', cancel, { once: true });
    stdoutPipe.setEncoding('utf8').on('data', (data: string) => (stdout += data));
    stderrPipe.setEncoding('utf8').on('data', (data: string) => (stderr += data));
    helper.on('error', (err) => {
      stderr += err.message;
      done(null);
    });
    helper.on('close', done);
  });
}

// Every process, listed; the listing's error is set when it is unusable.
// ps is let finish however long a loaded machine takes: a listing cut short names nothing. lstart is the start time
// the kernel recorded, so it is the same in every listing however late ps reads or answers; elapsed time read at an
// unknown moment of a slow listing would leave a window as long as the listing, wide enough for a reused pid.
async function snapshot(override?: CommandLine, signal?: AbortSignal) {
  const listing = override ?? ['ps', ['-e', '-o', 'pid=,ppid=,lstart=']]; // POSIX only; Windows uses a job object
  return commandCleanup.parseListing(
    await runHelper(listing, undefined, { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, signal),
  );
}

// Descendants of rootPid seen so far and still running, keyed by pid with their start time, so they can still be
// recognised after their parent exits and they are reparented. Only processes positively linked to rootPid are
// recorded. stop() also cancels a listing in progress.
export function watchDescendants(rootPid: number) {
  const seen: commandCleanup.Seen = new Map();
  const cancel = new AbortController();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { processes, error } = await snapshot(undefined, cancel.signal);
      if (!error) commandCleanup.observe(seen, rootPid, processes, process.pid);
      await new Promise((wake) => setTimeout(wake, POLL_GAP_MS));
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
      cancel.abort();
      return loop;
    },
  };
}

export type Watcher = ReturnType<typeof watchDescendants>;

export const errorCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

// POSIX: kill the root and every descendant observed under it, as commandCleanup.killPlan decides. Never touches other
// processes.
// shortcut: a descendant that was reparented before a poll saw it is missed; upgrade to a cgroup (#128) for exact
// containment.
export async function killTree(
  rootPid: number,
  seen: commandCleanup.Seen,
  killPid: (pid: number) => void,
  snapshotCommand?: CommandLine,
): Promise<commandCleanup.Cleanup> {
  const cleanupErrors: string[] = [];
  // Listed with the group stopped, before it is killed: no member can exit or start a process during the listing, so
  // a descendant detached from the group is still linked to its parent, not yet reparented.
  try {
    process.kill(-rootPid, 'SIGSTOP');
  } catch {} // the kill below reports a group it cannot signal
  const listing = await snapshot(snapshotCommand);
  try {
    process.kill(-rootPid, 'SIGKILL');
  } catch (err) {
    if (errorCode(err) !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${(err as Error).message}`);
  }
  if (listing.error) cleanupErrors.push(listing.error);
  const plan = commandCleanup.killPlan(rootPid, seen, listing, process.pid);
  const survivors: commandCleanup.Survivor[] = [];
  for (const pid of plan.kill)
    try {
      killPid(pid);
    } catch (err) {
      if (errorCode(err) !== 'ESRCH') survivors.push({ pid, error: (err as Error).message });
    }
  return { survivors: [...survivors, ...plan.survivors], cleanupErrors };
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
};
