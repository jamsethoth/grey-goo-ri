import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import * as commandCleanup from './command-cleanup.ts';
import * as containment from './containment.ts';

// The processes a shell command leaves, found and killed as lib/command-cleanup.ts decides, whichever way the command
// was held: the POSIX process listing, the watcher that follows a command's descendants and the group kill; the Windows
// job's termination and taskkill; and the helper processes that list and kill (exec.ts runs the command).

const POLL_GAP_MS = 250;
// How long a killed process group may take to empty before cleanup says it could not confirm that. SIGKILL takes effect
// at once, so what is left past this is stuck in the kernel, or a zombie nothing reaps (a container with no init).
const GROUP_EXIT_WAIT_MS = 30_000;
// How long a finished command's answer waits for the listing that names what it left. It sits in front of every Check,
// so a ps stalled in the kernel must not hold them all; past this, cleanup says it could not confirm. A timed-out
// command's listing has no bound: it finds what that kill must reach, and the command has used its time already.
const LEFTOVER_LISTING_WAIT_MS = 30_000;

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
  const listing = override ?? ['ps', ['-e', '-o', 'pid=,ppid=,lstart=,pgid=,args=']]; // POSIX only; Windows uses a job
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

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
};

// Whether a signal to the group finds a member: a group with none is gone, so every inheriting child is too (L14).
export const groupHasMembers = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== 'ESRCH';
  }
};

async function groupEmptied(pgid: number) {
  const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
  while (groupHasMembers(pgid)) {
    if (Date.now() > deadline) return false;
    await wait(20);
  }
  return true;
}

// What the hooks of a test replace in a cleanup: the POSIX kill, the process listing, the wait for it when a command
// has finished, and the tree kill.
export interface CleanupHooks {
  killPid?: (pid: number) => void;
  snapshotCommand?: CommandLine;
  leftoverListingWaitMs?: number;
  taskkillCommand?: CommandLine;
}
type Planned = Pick<commandCleanup.KillPlan, 'kill' | 'survivors'>;

// POSIX: the group stopped and listed, then killed; what `plan` decides from that listing killed too; and the group
// confirmed empty. Never touches other processes.
async function killGroup(
  rootPid: number,
  plan: (listing: commandCleanup.Listing) => Planned,
  killPid: (pid: number) => void,
  list: () => Promise<commandCleanup.Listing>,
): Promise<commandCleanup.Cleanup & { leftovers: commandCleanup.NamedProcess[] }> {
  const cleanupErrors: string[] = [];
  // Listed with the group stopped, before it is killed: no member can exit or start a process during the listing, so
  // a descendant detached from the group is still linked to its parent, not yet reparented.
  // A group found gone is not signalled again: over the listing's wait its number can come to name another group.
  let groupGone = false;
  try {
    process.kill(-rootPid, 'SIGSTOP');
  } catch (err) {
    groupGone = errorCode(err) === 'ESRCH'; // the kill below reports any other group it cannot signal
  }
  const listing = await list();
  if (!groupGone)
    try {
      process.kill(-rootPid, 'SIGKILL');
    } catch (err) {
      if (errorCode(err) !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${(err as Error).message}`);
    }
  if (listing.error) cleanupErrors.push(listing.error);
  const planned = plan(listing);
  const rowOf = (pid: number): commandCleanup.ProcessRow =>
    listing.processes.find((processRow) => processRow[0] === pid) ?? [pid, 0, ''];
  const survivors: commandCleanup.Survivor[] = [];
  for (const pid of planned.kill)
    try {
      killPid(pid);
    } catch (err) {
      if (errorCode(err) !== 'ESRCH') survivors.push(commandCleanup.survivorOf(rowOf(pid), (err as Error).message));
    }
  const leftovers = commandCleanup.leftoverRows(rootPid, planned, listing);
  if (!groupGone && !(await groupEmptied(rootPid))) {
    cleanupErrors.push(`process group ${rootPid} still has members after SIGKILL`);
    for (const { pid } of leftovers)
      if (isAlive(pid) && !survivors.some((survivor) => survivor.pid === pid))
        survivors.push(commandCleanup.survivorOf(rowOf(pid), 'still running after SIGKILL'));
  }
  return { survivors: [...survivors, ...planned.survivors], cleanupErrors, leftovers };
}

// POSIX: a timed-out command: the root and every descendant observed under it, as commandCleanup.killPlan decides.
// shortcut: a descendant that was reparented before a poll saw it is missed; upgrade to a cgroup (#128) for exact
// containment.
const killTree = (
  rootPid: number,
  seen: commandCleanup.Seen,
  killPid: (pid: number) => void,
  snapshotCommand?: CommandLine,
) =>
  killGroup(
    rootPid,
    (listing) => commandCleanup.killPlan(rootPid, seen, listing, process.pid),
    killPid,
    () => snapshot(snapshotCommand),
  );

// POSIX: what a command that has exited left: its group, and each descendant observed under it, as
// commandCleanup.leftoverPlan decides. The same shortcut as killTree's. With an empty group and no descendant ever seen
// there is nothing to list, so most commands take no listing at all.
const killLeftovers = async (
  rootPid: number,
  seen: commandCleanup.Seen,
  killPid: (pid: number) => void,
  { snapshotCommand, leftoverListingWaitMs = LEFTOVER_LISTING_WAIT_MS }: CleanupHooks,
) =>
  !seen.size && !groupHasMembers(rootPid)
    ? { survivors: [], cleanupErrors: [], leftovers: [] }
    : killGroup(
        rootPid,
        (listing) => commandCleanup.leftoverPlan(rootPid, seen, listing, process.pid),
        killPid,
        () => snapshot(snapshotCommand, AbortSignal.timeout(leftoverListingWaitMs)),
      );

// Windows: terminate the job and wait until it is empty. A job not confirmed empty keeps gg's handle, so kill-on-close
// takes what is left when gg exits.
async function terminateJob(
  job: containment.Job,
  rootPid: number,
  kernel32: containment.Kernel32 | null,
): Promise<commandCleanup.Cleanup> {
  let refused: string | undefined;
  try {
    job.terminate();
  } catch (err) {
    refused = (err as Error).message;
  }
  const cleanupErrors = refused ? [refused] : [];
  try {
    if (refused) {
      const survivors = job
        .members()
        .map((pid) => ({ ...containment.describe(kernel32, pid), error: `termination refused: ${refused}` }));
      return { survivors, cleanupErrors };
    }
    await job.emptied();
    job.close();
    return { survivors: [], cleanupErrors };
  } catch (err) {
    cleanupErrors.push(`could not verify the job is empty: ${(err as Error).message}`);
    return { survivors: [{ ...containment.describe(kernel32, rootPid), error: 'not verified gone' }], cleanupErrors };
  }
}

// Windows without a job: taskkill /T takes down what is still linked to the shell; orphans cannot be found. The linked
// descendants are listed first, while the links exist, to be named if taskkill is refused. taskkill is let finish:
// stopped partway on a loaded machine it can kill the shell but not the children it then no longer finds. The
// taskkillCommand seam gets the pid as its last argument.
async function takeDownTree(
  rootPid: number,
  kernel32: containment.Kernel32 | null,
  taskkillCommand: CommandLine | undefined,
  containmentError: string | undefined,
): Promise<commandCleanup.Cleanup> {
  const cleanupErrors = [containmentError] as string[];
  let linked: number[] = [];
  let listed = false;
  try {
    if (kernel32) {
      linked = containment.linkedDescendants(kernel32, rootPid);
      listed = true;
    }
  } catch (err) {
    cleanupErrors.push(
      `could not list the command's descendants (${(err as Error).message}); they are not verified gone`,
    );
  }
  const [command, args] = taskkillCommand ?? [`${containment.SYSTEM32}\\taskkill.exe`, ['/T', '/F', '/PID']];
  const result = await runHelper([command, [...args, String(rootPid)]]);
  if (result.code === 0 || result.code === 128) return { survivors: [], cleanupErrors }; // 128: already gone
  // taskkill /T ends the children first and cmd.exe can exit on its own once they go, so the kill of the shell can fail
  // with the tree down, for more than one reason in the Windows language (#285). What is left alive decides, when the
  // tree could be listed.
  const alive = [rootPid, ...linked].filter(isAlive);
  if (listed && !alive.length) return { survivors: [], cleanupErrors };
  cleanupErrors.push(
    `taskkill on command pid ${rootPid} failed: exit ${result.code}: ${(result.stderr || result.stdout).trim()}`,
  );
  const survivors = alive.map((pid) => ({
    ...containment.describe(kernel32, pid),
    error: 'still running after cleanup',
  }));
  return { survivors, cleanupErrors };
}

// A timed-out command taken down: its job terminated, its Windows tree killed by taskkill, or its POSIX tree killed.
export function takeDown(
  { child, job, containmentError }: containment.Started,
  kernel32: containment.Kernel32 | null,
  watcher: Watcher | null,
  testHooks: CleanupHooks,
) {
  const { killPid = (pid: number) => process.kill(pid, 'SIGKILL'), snapshotCommand, taskkillCommand } = testHooks;
  // The pid is unset only when spawn fails, which 'error' reports before a timeout can fire.
  const pid = child.pid as number;
  if (job) return terminateJob(job, pid, kernel32);
  if (process.platform === 'win32') return takeDownTree(pid, kernel32, taskkillCommand, containmentError);
  return killTree(pid, (watcher as Watcher).seen, killPid, snapshotCommand);
}

// What a finished command's cleanup did, with what it found running.
export type Settled = commandCleanup.Cleanup & { leftovers: commandCleanup.NamedProcess[] };

// The job's command exited: what it left running is named, then the job is terminated. An unreadable job names nothing,
// and its termination says the rest.
async function settleJob(
  job: containment.Job,
  rootPid: number,
  kernel32: containment.Kernel32 | null,
): Promise<Settled> {
  let leftovers: commandCleanup.NamedProcess[] = [];
  try {
    leftovers = job.leftovers(rootPid).map((pid) => containment.describe(kernel32, pid));
  } catch {}
  return { ...(await terminateJob(job, rootPid, kernel32)), leftovers };
}

// A command that has exited: what it left is ended, as its containment allows. With no job on Windows nothing is: a
// parent pid is not cleared when the parent ends and can be reused, so an unrelated older process can read as the
// command's child (PR #294), and the result stays unconfirmed for a human.
export function settle(
  { child, job, containmentError }: containment.Started,
  kernel32: containment.Kernel32 | null,
  watcher: Watcher | null,
  testHooks: CleanupHooks,
): Promise<Settled> {
  const { killPid = (pid: number) => process.kill(pid, 'SIGKILL') } = testHooks;
  // The pid is unset only when spawn fails, which 'error' reports with no 'exit'.
  const pid = child.pid as number;
  if (job) return settleJob(job, pid, kernel32);
  if (process.platform === 'win32')
    return Promise.resolve({ survivors: [], cleanupErrors: [containmentError as string], leftovers: [] });
  return killLeftovers(pid, (watcher as Watcher).seen, killPid, testHooks);
}
