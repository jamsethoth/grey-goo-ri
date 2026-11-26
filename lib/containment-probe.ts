// The containment probe's command (ADR 0030 decision 5, #533), for lib/exec.ts alone: an argv started as launch starts
// one, behind the gate in a new job, but with no watcher, which would adopt an escaped child, and asked at the first
// line that is a pid alone whether that pid is a member of the job.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import * as commandShim from './command-shim.ts';
import * as containment from './containment.ts';
import type * as exec from './exec.ts';
import * as cliDoctor from './harnesses/cli-doctor.ts';

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

const PID_LINE = /^\d+$/;

// The probe over kernel32, as lib/exec.ts's createExec gives it. Nothing in the job is left running when it resolves;
// a child that escaped the job is not the probe's to end.
export const childInJob =
  (kernel32: containment.Kernel32 | null) =>
  async ({ command, args, cwd, env, wallMs = cliDoctor.CHEAP_WALL_MS }: ChildInJobOptions): Promise<ChildInJob> => {
    let argv: { command: string; args: string[] };
    try {
      argv = commandShim.argvOf(command, args, env?.PATH, cwd);
    } catch (err) {
      return { lines: [], pid: null, inJob: null, failure: `${command} did not start: ${(err as Error).message}` };
    }
    const started = containment.startArgv(kernel32, argv, { cwd, env: env && { ...process.env, ...env } });
    const { child, job } = started;
    // startArgv spawns with every stdio a pipe.
    const [stdin, stdout, stderr] = [child.stdin, child.stdout, child.stderr] as [Writable, Readable, Readable];
    const lines: string[] = [];
    const { promise: seen, resolve } = Promise.withResolvers<ChildInJob>();
    const see = (found: Omit<ChildInJob, 'lines'>) => resolve({ lines: [...lines], ...found });
    const fail = (failure: string) => see({ pid: null, inJob: null, failure });
    if (!job) fail(`${command} ran uncontained: ${started.containmentError ?? 'no job'}`);
    void started.spawned.then((err) => err && fail(`${command} did not start: ${err.message}`));
    createInterface({ input: stdout }).on('line', (line) => {
      lines.push(line);
      if (!job || !PID_LINE.test(line.trim())) return;
      const pid = Number(line.trim());
      try {
        see({ pid, inJob: job.members().includes(pid), failure: null });
      } catch (err) {
        fail(`gg's job could not be read: ${(err as Error).message}`);
      }
    });
    stderr.resume();
    stdin.on('error', () => {}); // already gone: its exit reports it
    stdin.end();
    child.on('close', () => fail(`${command} ended before printing a pid`));
    const wall = setTimeout(() => fail(`${command} printed no pid within ${wallMs} ms`), wallMs);
    const result = await seen;
    clearTimeout(wall);
    try {
      // The gate's own libuv job ends the argv with it when gg's could not be made.
      if (job) job.terminate();
      else child.kill();
      await job?.emptied();
      job?.close();
      return result;
    } catch (err) {
      // A job not confirmed empty keeps its handle, as process-tree.ts's terminateJob does: kill-on-close ends it at
      // gg's exit.
      return { ...result, pid: null, inJob: null, failure: `gg's job could not be ended: ${(err as Error).message}` };
    } finally {
      // An escaped child can hold the pipes for as long as it runs.
      stdout.destroy();
      stderr.destroy();
    }
  };
