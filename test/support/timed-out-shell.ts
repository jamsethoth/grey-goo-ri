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
import * as shellCaseOptions from './shell-case-options.ts';

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
// The case's end waits for the run, also at its timeout, while the case's body still waits, and then ends what the run
// names: a cleanup that outlasted the case would read the next case's environment. The bound lets the file's later
// cases run when a run never answers; it ends nothing, so what that run holds still keeps the file open.
// options.kernel32, when given, is the FFI runShell runs on.
export async function timeOutWhen(
  commandLine: string,
  { kernel32, ...options }: ShellCaseOptions,
  ready: () => boolean,
  t: TestContext,
) {
  const { signal } = t;
  const { runShell } = kernel32 === undefined ? exec : exec.createExec({ kernel32 });
  const clock = new AbortController();
  let settled = false;
  let wasReady = false;
  const running = runShell(commandLine, shellOptions({ ...options, signal: clock.signal })).finally(() => {
    settled = true;
  });
  t.after(
    async () => {
      clock.abort();
      await running.then(
        ({ survivors = [], leftovers = [] }) => {
          for (const survivor of survivors) processProbe.endProcess(survivor.pid);
          for (const pid of leftovers) processProbe.endProcess(pid);
        },
        () => {},
      );
    },
    { timeout: shellCaseOptions.CASE.timeout },
  );
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
// processes start and are listed. beforeClock runs just before the clock starts; options go to runShell; ready, when
// given, replaces the wait for that order. A clock that started out of that order fails the case: the order is read
// again as the clock starts, since the cleanup that follows ends the middle whatever its order was.
export async function timedOutOrphan(
  t: TestContext,
  directory: string,
  name: string,
  {
    beforeClock,
    ready: givenReady,
    ...options
  }: ShellCaseOptions & { beforeClock?: () => void; ready?: () => boolean } = {},
) {
  const { pidFile, midFile, goFile, commandLine, middleExited } = childScripts.orphanChain(t, directory, name);
  let seen: commandCleanup.Seen = new Map();
  const held = () => {
    const pid = processProbe.pidIn(pidFile);
    return pid > 0 && (process.platform === 'win32' || seen.has(pid));
  };
  const inOrder = () => {
    if (!held()) return false;
    writeFileSync(goFile, '');
    if (!middleExited()) return false;
    beforeClock?.();
    return true;
  };
  let heldAtClock = false;
  let exitedAtClock = false;
  const ready = () => {
    const isReady = (givenReady ?? inOrder)();
    heldAtClock = held();
    exitedAtClock = middleExited();
    return isReady;
  };
  const { result, ready: wasReady } = await timeOutWhen(
    commandLine,
    { timeoutMs: 3500, ...options, onWatch: (watched) => (seen = watched) },
    ready,
    t,
  );
  const pid = processProbe.pidIn(pidFile);
  assert.ok(
    wasReady,
    `the chain ended before runShell held its grandchild ${pid} and the middle exited: ${result.output}`,
  );
  assert.ok(exitedAtClock, `the clock started before the middle ${processProbe.pidIn(midFile)} exited`);
  assert.ok(heldAtClock, `the clock started before runShell held the grandchild ${pid}`);
  return { result, pid };
}
