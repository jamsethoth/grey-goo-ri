// The containment probe's command (ADR 0030 decision 5, #533), for lib/exec.ts alone: an argv started as launch starts
// one, behind the gate in a new job, but with no watcher, which would adopt an escaped child, and asked at the first
// line that is a pid alone whether that pid is a member of the job.
import type * as containment from './containment.ts';
import type * as exec from './exec.ts';

// What the probe starts: an argv with no shell under the wall limit, which defaults to the cheap one.
export type ChildInJobOptions = Pick<exec.LaunchOptions, 'command' | 'args' | 'cwd' | 'env' | 'wallMs'>;

// What the probe saw: the lines its argv printed up to the first that is a pid alone, that pid, and whether it was in
// the argv's job when that line came. failure says why it could not tell (the argv did not start, ran uncontained, or
// ended or ran out its wall limit before printing a pid), with pid and inJob null.
export interface ChildInJob {
  lines: string[];
  pid: number | null;
  inJob: boolean | null;
  failure: string | null;
}

// Stub (#533 Red): the probe over kernel32, as lib/exec.ts's createExec gives it.
export const childInJob =
  (kernel32: containment.Kernel32 | null) =>
  async (options: ChildInJobOptions): Promise<ChildInJob> => {
    await Promise.resolve([kernel32, options]);
    return { lines: [], pid: null, inJob: null, failure: null };
  };
