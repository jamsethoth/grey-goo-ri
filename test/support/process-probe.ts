// What a case reads of the processes it started, and how it ends them. A pid is checked against the process it was
// recorded for, never alone: a pid read after its process ended can name another process by then, as Windows gives a
// freed pid out again within seconds on a busy machine (#332).
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as containment from '../../lib/containment.ts';

// The process each pid was recorded for, by what its command line holds: the pid file it was read from, since every
// script that writes one has that path among its arguments, or the whole command line remember() read. null records a
// process that had ended before it could be read.
const recorded = new Map<number, string | null>();

// kernel32, opened on the first Windows check rather than at import.
const windowsKernel32 = (() => {
  let opened: { kernel32: containment.Kernel32 | null } | undefined;
  return () => {
    opened ??= { kernel32: containment.openKernel32() };
    if (!opened.kernel32) throw new Error('process-probe reads command lines through node:ffi, which is unavailable');
    return opened.kernel32;
  };
})();

// Whether any process runs under pid. A Windows process that has exited can still answer its command line while
// something holds it open, so its command line alone does not say it runs.
const runs = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The command line of the process running under pid, or null when none runs there.
// shortcut: Windows and Linux (/proc) only, the platforms CI runs; macOS would need ps.
function commandLineOf(pid: number): string | null {
  if (!runs(pid)) return null;
  if (process.platform === 'win32') return containment.describe(windowsKernel32(), pid).commandLine;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') || null;
  } catch {
    return null;
  }
}

// Whether the process recorded for pid runs. No pid is an error, not an answer: process.kill(0, 0) signals the caller's
// own group, so a pid never written would read as running, and a wait for it to end would never end. A pid with no
// process recorded is an error too, since nothing tells its process from another that took the pid.
export const alive = (pid: number) => {
  if (!(pid > 0)) throw new Error(`no process to check: the pid is ${pid}`);
  const marker = recorded.get(pid);
  if (marker === undefined)
    throw new Error(`no process recorded for pid ${pid}: read it with pidIn, or remember it while it runs`);
  return marker !== null && (commandLineOf(pid)?.includes(marker) ?? false);
};

// Records the process now running under pid as the one a later check of that pid means. Called while the case knows
// the process runs; one already gone is recorded as ended.
export function remember(pid: number) {
  recorded.set(pid, commandLineOf(pid));
}

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
export const pidIn = (file: string) => {
  const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  if (pid > 0) recorded.set(pid, file);
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
