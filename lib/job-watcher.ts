import { setTimeout as wait } from 'node:timers/promises';
import * as commandCleanup from './command-cleanup.ts';
import * as containment from './containment.ts';

// A Windows command's job, watched and cleaned up, for lib/process-tree.ts alone: each process its command starts
// outside the job, as Windows starts a packaged app's, linked to the job's members, held and adopted as it is linked;
// at cleanup the job terminated, and each linked process ended and confirmed gone, or named (ADR 0030 decision 3).

// Each process outside the job linked to its members, held and adopted as it is linked, keyed by pid. Every gapMs, each
// watcher over its own snapshot (#531's choices). Cleanup polls once more before it ends the job, since a process can
// start outside it after the last poll.
export function watch(job: containment.Job, kernel32: containment.Kernel32, gapMs: number) {
  const linked: commandCleanup.Linked = new Map();
  const poll = () => {
    const starts = new Map<number, bigint | 'closed' | null>();
    const startOf = (pid: number) => {
      if (!starts.has(pid)) starts.set(pid, containment.startOf(kernel32, pid));
      return starts.get(pid) ?? null;
    };
    try {
      const entries = containment.processes(kernel32);
      const members = job.members();
      const watchReads = { selfPid: process.pid, startOf, exited: job.exited };
      const toLink = commandCleanup.newlyLinked(linked, members, entries, watchReads);
      const closed = commandCleanup.closedLinked(linked, members, entries, watchReads);
      for (const entry of entries) {
        const { pid, parentPid } = entry;
        // a linked pid gg could not open, or whose handle has signalled, is never held twice
        if (linked.has(pid)) continue;
        // closed to gg: named at cleanup, never ended (#531 decision 1)
        if (closed.includes(pid))
          linked.set(pid, { ...containment.describe(kernel32, pid), parentPid, started: null, held: false });
        // held only if it is still the process linked at this start
        const held = toLink.includes(pid) ? job.hold(entry, starts.get(pid) as bigint) : null;
        if (held) linked.set(pid, held);
      }
    } catch {} // a snapshot or a job that cannot be read links nothing this time; the job's termination says the rest
  };
  const cancel = new AbortController();
  const loop = (async () => {
    while (!cancel.signal.aborted) {
      poll();
      await wait(gapMs, undefined, { signal: cancel.signal }).catch(() => {});
    }
  })();
  return { linked, poll, stop: () => (cancel.abort(), loop) };
}

export type JobWatcher = ReturnType<typeof watch>;

// The watcher's last poll, the job terminated and waited on until it is empty, then each linked process gg holds ended
// and confirmed gone, or named. A cleanup not confirmed keeps gg's handles, so kill-on-close takes what is left when gg
// exits, or when the Run closes them (closeJob).
export async function terminate(
  job: containment.Job,
  rootPid: number,
  kernel32: containment.Kernel32 | null,
  watcher: JobWatcher | null,
): Promise<commandCleanup.Cleanup> {
  watcher?.poll();
  const cleanup = await emptyJob(job, rootPid, kernel32);
  const linked = watcher?.linked ?? new Map();
  await job.endHeld(commandCleanup.linkedToEnd(linked, job.exited));
  const named = new Set(cleanup.survivors.map(({ pid }) => pid));
  const linkedSurvivors = commandCleanup.linkedSurvivors(linked, job.exited).filter(({ pid }) => !named.has(pid));
  cleanup.survivors.push(...linkedSurvivors);
  if (!cleanup.survivors.length && !cleanup.cleanupErrors.length) job.close();
  return cleanup;
}

// The job terminated and waited on until it is empty.
async function emptyJob(
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
    return { survivors: [], cleanupErrors };
  } catch (err) {
    cleanupErrors.push(`could not verify the job is empty: ${(err as Error).message}`);
    return { survivors: [{ ...containment.describe(kernel32, rootPid), error: 'not verified gone' }], cleanupErrors };
  }
}

// The job's command exited: what it left running in the job is named, then the job is terminated. An unreadable job
// names nothing, and its termination says the rest.
export async function settle(
  job: containment.Job,
  rootPid: number,
  kernel32: containment.Kernel32 | null,
  watcher: JobWatcher | null,
): Promise<commandCleanup.Cleanup & { leftovers: commandCleanup.NamedProcess[] }> {
  let leftovers: commandCleanup.NamedProcess[] = [];
  try {
    leftovers = job.leftovers(rootPid).map((pid) => containment.describe(kernel32, pid));
  } catch {}
  return { ...(await terminate(job, rootPid, kernel32, watcher)), leftovers };
}
