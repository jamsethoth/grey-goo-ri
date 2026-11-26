// The real kernel32 functions (null off Windows), and copies with some replaced, as a job call that fails would answer.
import * as containment from '../../lib/containment.ts';
import * as processProbe from './process-probe.ts';

export const realKernel32 = containment.openKernel32();

type Replaced = {
  [Name in keyof containment.Kernel32]?: (
    ...args: Parameters<containment.Kernel32[Name]>
  ) => ReturnType<containment.Kernel32[Name]>;
};

export const withKernel32 = (replaced: Replaced) => ({ ...realKernel32, ...replaced }) as containment.Kernel32;

// A kernel32 that cannot create a job, as when the job object is refused.
export const noJob = () => withKernel32({ CreateJobObjectW: () => 0n });

// What gg may do with a process outside its job, in the order it tries them (ADR 0030 decision 3): put it in gg's job,
// in a new job of its own, or terminate it.
export type Adoption = 'gg-job' | 'new-job' | 'terminate';

const EXTENDED_LIMIT_INFORMATION = 9; // LimitFlags at byte 16
const BREAKAWAY_OK = 0x800;
const PROCESS_QUERY_LIMITED = 0x1000;
const ERROR_ACCESS_DENIED = 5;
// A handle as kernel32's functions take one.
type Handle = Parameters<containment.Kernel32['CloseHandle']>[0];

// A kernel32 whose jobs let a child break away, as gg's did before #530, so Git Bash's node leaves gg's job as a
// packaged app's child does (ADR 0021's replaced-function seam, #531). attempts records by pid each Adoption gg tries
// for a process outside gg's own start, and each Adoption in refused fails for it; refused 'terminate' fails every
// job's termination but gg's too. gg's job is the first job made, and its own start the first process put in one. With
// closedOutside, once gg's start is in its job, every process outside that job but the test's own is closed to gg, as
// one run under another account is: its OpenProcess fails with access denied.
export function breakawayJobs(refused: Adoption[] = [], { closedOutside = false } = {}) {
  const real = realKernel32!;
  const attempts = new Map<number, Adoption[]>();
  const pids = new Map<Handle, number>();
  let ggJob: Handle | undefined;
  let started = false;
  let denied = false;
  const outsideGgJob = (pid: number) => {
    const probe = real.OpenProcess(PROCESS_QUERY_LIMITED, 0, pid);
    if (!probe) return false;
    const inJob = Buffer.alloc(4);
    const outside = real.IsProcessInJob(probe, ggJob ?? 0n, inJob) !== 0 && inJob.readInt32LE() === 0;
    real.CloseHandle(probe);
    return outside;
  };
  const tried = (handle: Handle, adoption: Adoption) => {
    const pid = pids.get(handle) ?? 0;
    if (!attempts.has(pid)) processProbe.remember(pid); // held by gg's handle, so the pid is still this process
    attempts.set(pid, [...(attempts.get(pid) ?? []), adoption]);
    return !refused.includes(adoption);
  };
  const kernel32 = withKernel32({
    CreateJobObjectW: (...create) => {
      const job = real.CreateJobObjectW(...create);
      ggJob ??= job;
      return job;
    },
    SetInformationJobObject: (job, kind, limits, length) => {
      const flags = limits as Buffer;
      if (kind === EXTENDED_LIMIT_INFORMATION) flags.writeUInt32LE(flags.readUInt32LE(16) | BREAKAWAY_OK, 16);
      return real.SetInformationJobObject(job, kind, limits, length);
    },
    OpenProcess: (access, inherit, pid) => {
      denied = closedOutside && started && pid !== process.pid && outsideGgJob(pid);
      if (denied) return 0n;
      const handle = real.OpenProcess(access, inherit, pid);
      if (handle) pids.set(handle, pid);
      return handle;
    },
    GetLastError: () => (denied ? ERROR_ACCESS_DENIED : real.GetLastError()),
    CloseHandle: (handle) => {
      pids.delete(handle);
      return real.CloseHandle(handle);
    },
    AssignProcessToJobObject: (job, handle) => {
      const ggStart = !started;
      started = true;
      if (ggStart || tried(handle, job === ggJob ? 'gg-job' : 'new-job'))
        return real.AssignProcessToJobObject(job, handle);
      return 0;
    },
    TerminateProcess: (handle, code) => (tried(handle, 'terminate') ? real.TerminateProcess(handle, code) : 0),
    TerminateJobObject: (job, code) =>
      job !== ggJob && refused.includes('terminate') ? 0 : real.TerminateJobObject(job, code),
  });
  return { kernel32, attempts };
}

// A kernel32 whose job refuses termination, with the pids the job listed, so a case can see they all end. Each is
// recorded as the job lists it, while it runs.
export function refusedTermination() {
  const members = new Set<number>();
  const kernel32 = withKernel32({
    TerminateJobObject: () => 0,
    QueryInformationJobObject: (...query) => {
      const answered = realKernel32?.QueryInformationJobObject(...query) ?? 0;
      const list = query[2] as Buffer;
      if (answered)
        for (let i = 0; i < list.readUInt32LE(4); i++) {
          const pid = Number(list.readBigUInt64LE(8 + 8 * i));
          if (!members.has(pid)) processProbe.remember(pid);
          members.add(pid);
        }
      return answered;
    },
  });
  return { kernel32, members };
}
