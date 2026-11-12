// What a case reads of the processes it started, and how it ends them. A pid is checked against the process it was
// recorded for, never alone: a pid read after its process ended can name another process by then, as Windows gives a
// freed pid out again within seconds on a busy machine (#332). That other process started after the recorded one ended,
// so a pid means the recorded process only while the process under it started no later than when the recorded one was
// seen running.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as containment from '../../lib/containment.ts';

// For each recorded pid, when its process was last seen running (ms since the epoch): its pid file's write, since a
// pid file is written while the process it names runs, or when remember() found it, or the start a cleanup reported.
// null records a process that had ended before it could be seen.
const recorded = new Map<number, number | null>();

// How much later than the true start a start read here can be: Windows gives it to the millisecond, Linux in clock
// ticks of 10 ms against an uptime of 10 ms.
const START_READ_MS = process.platform === 'win32' ? 1 : 20;
// ps lstart gives whole seconds, from a boot time that can itself be a second off.
const LSTART_MS = 2000;

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
    // field 22 is the start in clock ticks (100 a second) since boot, which /proc/uptime counts in seconds
    const uptimeMs = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
    return Date.now() - uptimeMs + Number(fields[19]) * 10;
  } catch {
    return null;
  }
}

// Whether the process recorded for pid runs. No pid is an error, not an answer: process.kill(0, 0) signals the caller's
// own group, so a pid never written would read as running, and a wait for it to end would never end. A pid with no
// process recorded is an error too, since nothing tells its process from another that took the pid.
export const alive = (pid: number) => {
  if (!(pid > 0)) throw new Error(`no process to check: the pid is ${pid}`);
  const seen = recorded.get(pid);
  if (seen === undefined)
    throw new Error(`no process recorded for pid ${pid}: read it with pidIn, or remember it while it runs`);
  const started = startOf(pid);
  return seen !== null && started !== null && started <= seen + START_READ_MS;
};

// Records the process under pid as the one a later check of that pid means: by started, its start as a cleanup
// reported it (an ISO time, or ps lstart in UTC), or else as the process running now, recorded as ended if none is.
// Without started it must be called while the case knows the process runs.
export function remember(pid: number, started?: string | null) {
  if (started) {
    const iso = started.includes('T');
    recorded.set(pid, Date.parse(iso ? started : `${started} UTC`) + (iso ? 0 : LSTART_MS));
  } else recorded.set(pid, startOf(pid) === null ? null : Date.now());
}

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
export const pidIn = (file: string) => {
  const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  if (pid > 0) recorded.set(pid, statSync(file).mtimeMs);
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
