// runShell timed out once the processes a case checks exist, however slowly they start. Spawns processes, so a test
// that calls it is medium (docs/testing.md).
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type * as commandCleanup from '../../lib/command-cleanup.ts';
import type * as containment from '../../lib/containment.ts';
import * as exec from '../../lib/exec.ts';
import * as childScripts from './child-scripts.ts';
import * as processProbe from './process-probe.ts';

// runShell's real inputs, cwd and timeoutMs, and its test hooks, with the FFI it runs on when one is given.
export type ShellCaseOptions = {
  cwd?: string;
  timeoutMs?: number;
  kernel32?: containment.Kernel32 | null;
} & exec.TestHooks;

// A timed-out run's result, which names its survivors and its cleanup errors (lib/exec.ts's ShellResult).
export type TimedOutResult = exec.ShellResult & { survivors: commandCleanup.Survivor[]; cleanupErrors: string[] };

// A clock that never starts: the command runs in the job, and only its own end ends it.
export const noClock = () => new AbortController().signal;

// runShell's real inputs, and the rest of a case's options as its test hooks.
export const shellOptions = ({ cwd, timeoutMs, ...testHooks }: ShellCaseOptions = {}): exec.ShellOptions => ({
  cwd,
  timeoutMs,
  testHooks,
});

// Runs commandLine with its timeout clock held until ready() holds, so the processes a case checks exist before the
// timeout fires however slowly they start. ready is false when the command ended first.
// The case's own signal ends the wait too, and then the command is timed out before the case fails.
// options.kernel32, when given, is the FFI runShell runs on.
export async function timeOutWhen(
  commandLine: string,
  { kernel32, ...options }: ShellCaseOptions,
  ready: () => boolean,
  signal: AbortSignal,
) {
  const { runShell } = kernel32 === undefined ? exec : exec.createExec({ kernel32 });
  const clock = new AbortController();
  let settled = false;
  let wasReady = false;
  const running = runShell(commandLine, shellOptions({ ...options, signal: clock.signal })).finally(() => {
    settled = true;
  });
  try {
    while (!settled && !signal.aborted && !ready()) await sleep(50);
    wasReady = !signal.aborted && ready();
  } finally {
    // also when ready() throws, as it can once a failed case's files are gone: the command is timed out and cleaned up
    // before the case goes on, and the error ready() threw is the one the case reports
    clock.abort();
    await running.catch(() => {});
  }
  const result = (await running) as TimedOutResult;
  signal.throwIfAborted();
  return { result, ready: wasReady };
}

// Times out an orphan chain once runShell holds its grandchild (on POSIX, once its watcher has listed it; on Windows
// the job holds it from the start) and the middle has then exited, so the grandchild is an orphan however slowly the
// processes start and are listed. beforeClock runs just before the clock starts; options go to runShell. The
// grandchild is killed when the case ends.
export async function timedOutOrphan(
  t: TestContext,
  directory: string,
  name: string,
  { beforeClock, ...options }: ShellCaseOptions & { beforeClock?: () => void } = {},
) {
  const { pidFile, midFile, goFile, commandLine } = childScripts.orphanChain(t, directory, name);
  t.after(() => processProbe.endProcessIn(pidFile));
  let seen: commandCleanup.Seen = new Map();
  const ready = () => {
    const pid = processProbe.pidIn(pidFile);
    if (!pid || (process.platform !== 'win32' && !seen.has(pid))) return false;
    writeFileSync(goFile, '');
    const mid = processProbe.pidIn(midFile);
    if (!mid || processProbe.alive(mid)) return false;
    beforeClock?.();
    return true;
  };
  const { result, ready: wasReady } = await timeOutWhen(
    commandLine,
    { timeoutMs: 3500, ...options, onWatch: (watched) => (seen = watched) },
    ready,
    t.signal,
  );
  const pid = processProbe.pidIn(pidFile);
  assert.ok(
    wasReady,
    `the chain ended before runShell held its grandchild ${pid} and the middle exited: ${result.output}`,
  );
  return { result, pid };
}
