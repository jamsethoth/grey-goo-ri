// What a case reads of the processes it started, and how it ends them.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Whether a process runs. No pid is an error, not an answer: process.kill(0, 0) signals the caller's own group, so a
// pid never written would read as running, and a wait for it to end would never end.
export const alive = (pid: number) => {
  if (!(pid > 0)) throw new Error(`no process to check: the pid is ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
export const pidIn = (file: string) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

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
  try {
    process.kill(pid);
  } catch {}
}

// Ends the process whose pid is in pidFile, if it wrote one and still runs.
export function endProcessIn(pidFile: string) {
  try {
    if (pidIn(pidFile)) process.kill(pidIn(pidFile));
  } catch {}
}
