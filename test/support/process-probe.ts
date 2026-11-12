// What a case reads of the processes it started, and how it ends them. A pid is checked against the process it was
// recorded for, never alone: a pid read after its process ended can name another process by then, as Windows gives a
// freed pid out again within seconds on a busy machine (#332). That other process started after the recorded one ended,
// so a pid means the recorded process only while the process under it started no later than when the recorded one was
// seen running, or, for a start a cleanup reported, only while the process under it has that start.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as commandCleanup from '../../lib/command-cleanup.ts';
import * as containment from '../../lib/containment.ts';

// What each recorded pid's process is known by: seenBy, when it was seen running (ms since the epoch), that is its pid
// file's write, since a pid file is written while the process it names runs, or when remember() found it; or started,
// its start as a cleanup reported it. null records a process that could not be told apart: it had ended before it was
// seen, or its cleanup reported no start.
type Recorded = { seenBy: number } | { started: string } | null;
const recorded = new Map<number, Recorded>();

// How much later than its pid file's write a process's start can read: measured at 0.6 ms on Windows over 200 spawns,
// and at 8 ms on Linux, whose start counts clock ticks of 10 ms against an uptime of 10 ms.
const START_READ_MS = process.platform === 'win32' ? 2 : 20;
// The widest a clock sample may be: the boot time read between two wall times this close is that close to true.
const CLOCK_SAMPLE_MS = 2;

// kernel32, opened on the first Windows check rather than at import.
const windowsKernel32 = (() => {
  let opened: { kernel32: containment.Kernel32 | null } | undefined;
  return () => {
    opened ??= { kernel32: containment.openKernel32() };
    if (!opened.kernel32) throw new Error('process-probe reads start times through node:ffi, which is unavailable');
    return opened.kernel32;
  };
})();

// Whether any process runs under pid. A Windows process that has exited can still answer while something holds it
// open, so a start time alone does not say it runs.
const runs = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// When Linux booted, in wall time: /proc/uptime read between two wall samples, again until they are close, so a pause
// between the reads cannot move it. shortcut: a wall clock stepped between a record and its check moves both apart;
// upgrade to boot-relative records if a case ever runs across a clock step.
function bootTime() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const before = Date.now();
    const uptimeMs = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
    if (Date.now() - before <= CLOCK_SAMPLE_MS) return before - uptimeMs;
  }
  throw new Error(`process-probe could not read the clock within ${CLOCK_SAMPLE_MS} ms in 100 attempts`);
}

// When the process running under pid started (ms since the epoch), or null when none runs there.
// shortcut: Windows and Linux (/proc) only, the platforms CI runs; macOS would need ps.
function startOf(pid: number): number | null {
  if (!runs(pid)) return null;
  if (process.platform === 'win32') {
    const { created } = containment.describe(windowsKernel32(), pid);
    return created === null ? null : Date.parse(created);
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // from field 3 on: the name may hold spaces
    if (fields[0] === 'Z') return null; // a zombie runs nothing
    return bootTime() + Number(fields[19]) * 10; // field 22: the start in clock ticks, 100 a second, since boot
  } catch {
    return null;
  }
}

// The start of the process running under pid as a cleanup reports it, or null when none runs there: the creation time
// on Windows, ps lstart in UTC elsewhere, read as lib/command-cleanup.ts reads its listing.
function reportedStartOf(pid: number): string | null {
  if (!runs(pid)) return null;
  if (process.platform === 'win32') return containment.describe(windowsKernel32(), pid).created;
  const listing = spawnSync('ps', ['-o', 'pid=,ppid=,lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const row = commandCleanup.parseListing({ code: listing.status, stdout: listing.stdout, stderr: listing.stderr })
    .processes[0];
  return row?.[0] === pid ? row[2] : null;
}

// Whether the process recorded for pid runs. No pid is an error, not an answer: process.kill(0, 0) signals the caller's
// own group, so a pid never written would read as running, and a wait for it to end would never end. A pid with no
// process recorded is an error too, since nothing tells its process from another that took the pid.
export const alive = (pid: number) => {
  if (!(pid > 0)) throw new Error(`no process to check: the pid is ${pid}`);
  const known = recorded.get(pid);
  if (known === undefined)
    throw new Error(`no process recorded for pid ${pid}: read it with pidIn, or remember it while it runs`);
  if (known === null) return false;
  // a start a cleanup reported is the same process only with the same start, as lib/command-cleanup.ts decides
  if ('started' in known) return reportedStartOf(pid) === known.started;
  const started = startOf(pid);
  return started !== null && started <= known.seenBy + START_READ_MS;
};

// Records the process under pid as the one a later check of that pid means. Given started, the start its cleanup
// reported, by that start; given null, a cleanup that reported none, as a process no check can tell apart. Given
// neither, as the process running now, so it must be called while the case knows the process runs.
export function remember(pid: number, started?: string | null) {
  if (started !== undefined) recorded.set(pid, started === null ? null : { started });
  else recorded.set(pid, runs(pid) ? { seenBy: Date.now() } : null);
}

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
export const pidIn = (file: string) => {
  const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  if (pid > 0) recorded.set(pid, { seenBy: statSync(file).mtimeMs });
  return pid;
};

// Waits for holds() to hold. A case that waits for an event that never comes fails at its own timeout, which aborts
// signal and so ends the wait, letting the case's cleanup run.
export async function waitFor(holds: () => boolean, signal: AbortSignal) {
  while (!holds()) {
    signal.throwIfAborted();
    await sleep(50);
  }
}

// Ends a process the case started, if it still runs.
export function endProcess(pid: number) {
  if (!alive(pid)) return;
  try {
    process.kill(pid);
  } catch {}
}

// Ends the process whose pid is in pidFile, if it wrote one and still runs.
export function endProcessIn(pidFile: string) {
  const pid = pidIn(pidFile);
  if (pid) endProcess(pid);
}
