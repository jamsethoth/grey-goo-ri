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
