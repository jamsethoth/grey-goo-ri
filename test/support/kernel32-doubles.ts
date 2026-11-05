// The real kernel32 functions (null off Windows), and copies with some replaced, as a job call that fails would answer.
import * as containment from '../../lib/containment.ts';

export const realKernel32 = containment.openKernel32();

type Replaced = {
  [Name in keyof containment.Kernel32]?: (
    ...args: Parameters<containment.Kernel32[Name]>
  ) => ReturnType<containment.Kernel32[Name]>;
};

export const withKernel32 = (replaced: Replaced) => ({ ...realKernel32, ...replaced }) as containment.Kernel32;

// A kernel32 that cannot create a job, as when the job object is refused.
export const noJob = () => withKernel32({ CreateJobObjectW: () => 0n });
