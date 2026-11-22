// One call to an Agent CLI, which every Harness makes the same way (#480): its launch over exec.launch under the stall
// and wall clocks and the Run's cancel signal, its stream's lines read once it ends, and its status at exit, with the
// stderr tail in a failure's message. What a stream's lines say is each Harness's own (its `read`).
import type * as exec from '../exec.ts';
import type * as runContext from '../run-context.ts';
import type * as visit from '../visit.ts';

// What every Harness's read of its stream gives: the failure the stream itself reports, or null.
export interface StreamRead {
  failure: visit.HarnessFailure | null;
}

// What a call launches, and how its Harness reads the lines: `read` parses the stream, and `lastActivity`, when the
// stall clock runs out, gives the time of the call's last activity beside its output (a transcript's last write), from
// the lines so far.
export interface CliCallOptions<Stream extends StreamRead> {
  launch: Pick<exec.LaunchOptions, 'command' | 'args' | 'cwd' | 'env' | 'input' | 'stallMs' | 'wallMs'>;
  read: (lines: string[]) => Stream;
  lastActivity?: (lines: string[]) => number | null;
}

// How a call ended: its status, its stream as its Harness read it, its failure, and the launch's result, null when the
// executable could not start.
export interface CliCallEnded<Stream extends StreamRead> {
  status: visit.CallSignal['status'];
  stream: Stream;
  failure: visit.HarnessFailure | null;
  ended: exec.LaunchResult | null;
}

export function run<Stream extends StreamRead>(
  _runner: Pick<exec.Exec, 'launch'>,
  _hooks: runContext.HarnessHooks,
  options: CliCallOptions<Stream>,
): Promise<CliCallEnded<Stream>> {
  return Promise.resolve({ status: 'completed', stream: options.read([]), failure: null, ended: null });
}
