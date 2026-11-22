// One scripts/record-codex.ts call (#479): codex started with no shell inside a new Windows job, as lib/exec.ts's
// launch starts an argv, the prompt on stdin, each stdout line kept with its arrival time. When a line first names
// the watch or kill marker (a command the prompt runs), the job's members and every process whose command line names
// the marker are listed, so a process the sandbox starts outside the job shows (issue decision 5, F7); a kill marker
// then terminates the job, as gg stops a call, and lists what is left.
import { createInterface } from 'node:readline';
import * as commandShim from '../lib/command-shim.ts';
import * as containment from '../lib/containment.ts';

// A call that runs past this is killed, and its lines kept.
const CALL_LIMIT_MS = 600_000;
// How long a marked command runs before the job is listed: long enough for the sandbox to have started it.
const SETTLE_MS = 4_000;
// The session's own variables, which a nested codex would read as its parent's, and any API key of the user's.
const INHERITED = /^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI)/;

export interface Call {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  watch?: string;
  killOn?: string;
}

interface Listing {
  jobMembers: { pid: number; exe: string; commandLine: string | null }[];
  markerProcesses: { pid: number; exe: string; inJob: boolean }[];
}

export interface Output {
  lines: string[];
  timesMs: number[];
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  killed: string | null;
  job: { contained: boolean; whileMarked: Listing | null; afterKill: Listing | null; leftAfterExit: number[] };
}

// The job's members, described, and every process on the machine whose command line names the marker.
function listing(kernel32: containment.Kernel32 | null, job: containment.Job | null, marker: string): Listing | null {
  if (kernel32 === null) return null;
  const members = new Set(job?.members() ?? []);
  const described = containment
    .processes(kernel32)
    .map((entry) => ({ ...entry, commandLine: containment.describe(kernel32, entry.pid).commandLine }));
  return {
    jobMembers: described
      .filter((entry) => members.has(entry.pid))
      .map(({ pid, exe, commandLine }) => ({ pid, exe, commandLine })),
    markerProcesses: described
      .filter((entry) => entry.commandLine?.includes(marker) && entry.pid !== process.pid)
      .map(({ pid, exe }) => ({ pid, exe, inJob: members.has(pid) })),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(call: Call): Promise<Output> {
  const kernel32 = containment.openKernel32();
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.test(key))),
    ...call.env,
  };
  const started = containment.startArgv(kernel32, commandShim.argvOf('codex', call.argv), { cwd: call.cwd, env });
  const { child, job } = started;
  const { stdout, stderr, stdin } = child;
  if (!stdout || !stderr || !stdin) throw new Error('the launch gate has no pipes');
  const begun = Date.now();
  const output: Output = {
    lines: [],
    timesMs: [],
    stderr: started.containmentError ?? '',
    exitCode: null,
    signal: null,
    killed: null,
    job: { contained: job !== null, whileMarked: null, afterKill: null, leftAfterExit: [] },
  };
  const kill = (why: string) => {
    output.killed ??= why;
    job?.terminate();
  };
  const limit = setTimeout(() => kill('call limit'), CALL_LIMIT_MS);
  const marker = call.killOn ?? call.watch;
  let marked = false;
  const onMarked = async () => {
    await delay(SETTLE_MS);
    output.job.whileMarked = listing(kernel32, job, marker ?? '');
    if (call.killOn === undefined) return;
    kill(`job terminated ${SETTLE_MS} ms after ${call.killOn} first appeared`);
    await delay(SETTLE_MS);
    output.job.afterKill = listing(kernel32, job, call.killOn);
  };
  const markedDone: Promise<void>[] = [];
  createInterface({ input: stdout }).on('line', (line) => {
    output.lines.push(line);
    output.timesMs.push(Date.now() - begun);
    if (marker !== undefined && !marked && line.includes(marker)) {
      marked = true;
      markedDone.push(onMarked());
    }
  });
  stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()));
  stdin.on('error', () => {}); // exited before reading the prompt: its exit reports it
  stdin.end(call.prompt);
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
    child.on('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
  );
  clearTimeout(limit);
  await Promise.all(markedDone);
  if (job !== null) {
    output.job.leftAfterExit = job.members();
    job.terminate();
    job.close();
  }
  return { ...output, exitCode: code, signal };
}
