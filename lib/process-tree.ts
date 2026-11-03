import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

// The processes a timed-out shell command leaves, found and killed: the POSIX process listing, the watcher that follows
// a command's descendants, the tree kill, and the helper processes that list and kill them (exec.ts runs the command).

const POLL_GAP_MS = 250;

// A process as a listing names it: its pid, its parent's pid, and its start time as the kernel recorded it.
type ProcessRow = [pid: number, parentPid: number, started: string];
// A command and its arguments, as the test hooks replace a helper process with.
export type CommandLine = [command: string, args: string[]];
// The descendants a POSIX watcher has seen, keyed by pid.
export type Seen = Map<number, ProcessRow>;

// A process that could not be killed or confirmed gone, and why.
export interface Survivor {
  pid: number;
  error: string;
}

// What a timed-out command's cleanup left: survivors, and cleanupErrors for anything that could not be confirmed gone.
export interface Cleanup {
  survivors: Survivor[];
  cleanupErrors: string[];
}

// Result of a helper process: { code, stdout, stderr }. Never rejects; code is null if it failed to start, outlived ms
// or was cancelled by signal. Without ms it is let finish, as taskkill /T must be: stopped partway on a loaded machine
// it can kill the shell but not the children it then no longer finds.
export function quick(
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

// { processes, error } for every process; error is set when the snapshot is unusable.
// ps is let finish however long a loaded machine takes: a listing cut short names nothing. lstart is the start time
// the kernel recorded, so it is the same in every listing however late ps reads or answers; elapsed time read at an
// unknown moment of a slow listing would leave a window as long as the listing, wide enough for a reused pid.
async function snapshot(override?: CommandLine, signal?: AbortSignal) {
  const listing = override ?? ['ps', ['-e', '-o', 'pid=,ppid=,lstart=']]; // POSIX only; Windows uses a job object
  const result = await quick(listing, undefined, { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, signal);
  const processes = result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length > 2 && /^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!))
    .map(([pid, parentPid, ...started]): ProcessRow => [Number(pid), Number(parentPid), started.join(' ')]);
  const failure = result.code === null ? 'did not start' : 'exit ' + result.code;
  const error =
    result.code !== 0 || !processes.length
      ? `process snapshot failed (${failure}): ${result.stderr.trim()}`.trim()
      : undefined;
  return { processes, error };
}

const sameProcess = (left: ProcessRow, right: ProcessRow) => left[0] === right[0] && left[2] === right[2];

// Grows `tree` with every listed process whose parent is in it, until no more join; `onJoin` sees each that does.
function growTree(tree: Set<number>, processes: ProcessRow[], onJoin: (processRow: ProcessRow) => void = () => {}) {
  for (let grew = true; grew;) {
    grew = false;
    for (const processRow of processes)
      if (!tree.has(processRow[0]) && tree.has(processRow[1]) && processRow[0] !== process.pid) {
        tree.add(processRow[0]);
        onJoin(processRow);
        grew = true;
      }
  }
}

// Descendants of rootPid seen so far and still running, keyed by pid with their start time, so they can still be
// recognised after their parent exits and they are reparented. Only processes positively linked to rootPid are
// recorded. stop() also cancels a listing in progress.
export function watch(rootPid: number) {
  const seen: Seen = new Map();
  const cancel = new AbortController();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { processes, error } = await snapshot(undefined, cancel.signal);
      if (!error) {
        const listed = new Set(processes.map((processRow) => processRow[0]));
        // gone: its pid may come to name another process
        for (const pid of seen.keys()) if (!listed.has(pid)) seen.delete(pid);
        growTree(new Set([rootPid, ...seen.keys()]), processes, (processRow) => seen.set(processRow[0], processRow));
      }
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

export type Watcher = ReturnType<typeof watch>;

export const errorCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

// The processes still linked to rootPid in a listing taken with the group stopped: rootPid, each descendant the
// watcher saw that still has its start time, and whatever those have started.
function aliveTree(rootPid: number, seen: Seen, processes: ProcessRow[]) {
  const alive = new Set([rootPid]);
  for (const processRow of processes) {
    const known = seen.get(processRow[0]);
    if (known && sameProcess(known, processRow)) alive.add(processRow[0]);
  }
  growTree(alive, processes);
  return alive;
}

// POSIX: kill the root and every descendant observed under it. Never touches other processes.
// shortcut: a descendant that was reparented before a poll saw it is missed; upgrade to a cgroup (#128) for exact
// containment.
export async function killTree(
  rootPid: number,
  seen: Seen,
  killPid: (pid: number) => void,
  snapshotCommand?: CommandLine,
): Promise<Cleanup> {
  const cleanupErrors: string[] = [];
  // Listed with the group stopped, before it is killed: no member can exit or start a process during the listing, so
  // a descendant detached from the group is still linked to its parent, not yet reparented.
  try {
    process.kill(-rootPid, 'SIGSTOP');
  } catch {} // the kill below reports a group it cannot signal
  const { processes, error } = await snapshot(snapshotCommand);
  try {
    process.kill(-rootPid, 'SIGKILL');
  } catch (err) {
    if (errorCode(err) !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${(err as Error).message}`);
  }
  const survivors: Survivor[] = [];
  const tryKill = (pid: number) => {
    try {
      killPid(pid);
    } catch (err) {
      if (errorCode(err) !== 'ESRCH') survivors.push({ pid, error: (err as Error).message });
    }
  };
  if (error) {
    // cannot tell what is alive: attempt the root, and report every known descendant rather than claim success
    cleanupErrors.push(error);
    tryKill(rootPid);
    for (const pid of seen.keys())
      if (!survivors.some((survivor) => survivor.pid === pid))
        survivors.push({ pid, error: 'not verified gone: ' + error });
    return { survivors, cleanupErrors };
  }
  const alive = aliveTree(rootPid, seen, processes);
  for (const pid of alive) if (processes.some((processRow) => processRow[0] === pid)) tryKill(pid);
  // A listed pid with another start time is a new process under a reused pid, not ours to kill, or ours after a
  // wall-clock step moved every start time ps reports: left alone, and not claimed gone.
  for (const processRow of processes)
    if (seen.has(processRow[0]) && !alive.has(processRow[0]))
      survivors.push({ pid: processRow[0], error: 'not verified gone: its pid now has another start time' });
  return { survivors, cleanupErrors };
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
};
