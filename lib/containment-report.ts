// What a command reports of its containment, for lib/exec.ts alone: what a later Run can check (L14), a launch's
// started reports, and its Command Cleanup report.
import * as commandCleanup from './command-cleanup.ts';
import type * as containment from './containment.ts';
import type * as exec from './exec.ts';
import type * as processTree from './process-tree.ts';

// How gg can check later that the command's processes are gone (L14). exec's own containment says whether the command
// dies with gg, which a POSIX process group does not; this one says what there is to check, which it does give.
export function cleanupContainmentOf({ child, job }: containment.Started): commandCleanup.CleanupContainment {
  if (job) return { kind: 'job' };
  return process.platform === 'win32' ? { kind: 'none' } : { kind: 'group', pgid: child.pid as number };
}

// A launch's started reports: its containment once, before the result, since a gate a stop left running may never
// answer; and none, after it, at its watcher's first sight of an escapee (#532, ADR 0030 decision 4). A report that
// throws, a failed save, calls takeDown, after the watcher has ended any escapee (Q2 A): launch's, which takes the call
// down as the cancel does unless it has exited. Only the watcher's report throws on; launch has no caller to throw to,
// and the Harness's caller keeps the error to rethrow (agent-call).
export function startedReports(
  onStarted: exec.LaunchOptions['onStarted'],
  cleanupContainment: commandCleanup.CleanupContainment,
  takeDown: () => unknown,
) {
  let reported = false;
  const report = (containment: commandCleanup.CleanupContainment) => {
    try {
      onStarted?.(containment);
    } catch (err) {
      queueMicrotask(() => void takeDown());
      throw err;
    }
  };
  const first = () => !reported && ((reported = true), report(cleanupContainment));
  const started = () => {
    try {
      first();
    } catch {}
  };
  const escapee = () => {
    first();
    report({ kind: 'none' });
  };
  return { started, escapee };
}

// A command's Command Cleanup report, none when its watcher linked an escapee and it is unconfirmed (#532 Q3 A). An
// unconfirmed job keeps gg's handle, for the Run to close (closeJob).
export function reportOf(
  started: containment.Started,
  cleanupContainment: commandCleanup.CleanupContainment,
  cleanup: commandCleanup.Cleanup,
  watcher: ReturnType<typeof processTree.watch>,
) {
  const escaped = watcher !== null && 'linked' in watcher && watcher.linked.size > 0;
  const report = commandCleanup.cleanupReport(cleanupContainment, cleanup, { escaped });
  if (started.job && !report.confirmed)
    Object.defineProperty(report, 'closeJob', { value: () => (started.job as containment.Job).close() });
  return report;
}
