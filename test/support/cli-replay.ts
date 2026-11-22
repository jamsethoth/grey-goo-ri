// An Agent CLI replayed from its recordings, for any Harness's tests (#480): `replayLaunch`, a launch double that
// answers each argv in-process, a small test's stand-in for the CLI; and `fakeCli`, gg's real launch with the command
// it starts replaced by node running the fake CLI (child-scripts/fake-cli.ts), which replays a recorded call at each
// model call: the same one, or the next of several a case names. What a Harness's CLI answers, where its transcript
// goes and what its environment holds are that Harness's support module's. fakeCli spawns, so only medium tests call
// it.
import type { TestContext } from 'node:test';
import type * as exec from '../../lib/exec.ts';

// What the CLI printed for a command and its exit code, as a recording keeps it.
export interface Answer {
  stdout: string;
  exitCode: number;
}

// A command that is no model call, with the answer the CLI gives it.
export interface RecordedCommand extends Answer {
  argv: string[];
}

// How a case changes the launch beside the answer: an executable that cannot start, and the first argument of a
// command that times out printing nothing, that exits 1 printing nothing, or that a signal ends printing nothing
// (code null, as on POSIX).
export interface LaunchState {
  missing?: boolean;
  hangs?: string;
  fails?: string;
  killed?: string;
}

// A launch that answers each argv in-process with `answer`, and every launch it was asked for.
export function replayLaunch(_answer: (args: readonly string[]) => Answer, _state: LaunchState = {}) {
  const launches: exec.LaunchOptions[] = [];
  const launch = (_options: exec.LaunchOptions): Promise<exec.LaunchResult> =>
    Promise.resolve({
      code: null,
      signal: null,
      timedOut: null,
      cancelled: false,
      stderrTail: '',
      cleanup: { confirmed: false, survivors: [], reason: null, containment: { kind: 'none' } },
    });
  return { launch, launches };
}

// Where a model call's transcript goes and the file copied there, from the launch, the recording it replays (its path
// with no extension, as copied into the fake's directory) and the CLI's home directory; null writes none.
export type TranscriptOf = (call: {
  launched: exec.LaunchOptions;
  recording: string;
  home: string;
}) => { path: string; from: string } | null;

export interface FakeCliOptions {
  // The directory holding each recording as <name>.json (its exit code and the files it changed) and <name>.jsonl.
  recordings: string;
  // The recording the fake replays; with several, each model call replays the next, and any after the last the last.
  scenario: string | string[];
  // The commands that are no model call, each answered as recorded; any other argv is a model call.
  commands?: RecordedCommand[];
  // The `type` of the line that carries the call's result, which `no-result`, `hang` and `signal` leave out.
  resultType: string;
  // How the fake changes the replay: `replay`, `no-result`, `garbage`, `hang`, `hang-no-transcript` or `signal`.
  mode?: string;
  transcript?: TranscriptOf;
  // The environment the CLI reads its home from, given that directory.
  env?: (home: string) => Record<string, string>;
  // Whether the fake leaves an orphan descendant running, whose pid it writes to orphanPidFile; the call's stall and
  // wall clocks count from that write (#475).
  orphan?: boolean;
  // What the fake writes to its stderr.
  stderr?: string;
  // The executable launched in place of the CLI, node unless a case names one that does not exist.
  command?: string;
  // Whether each launch checks that every absolute path it carries holds a space (#426).
  spaced?: boolean;
}

// A received model call: its argv after the executable, and its stdin.
export interface Received {
  argv: string[];
  stdin: string | null;
}

// The fake CLI in a temp directory holding the CLI's home, the repository a call runs in, the Run directory, and the
// fake's script and recordings, copied there; its launch, every launch it was asked for, and what the fake received.
export function fakeCli(_t: TestContext, _options: FakeCliOptions) {
  const launches: exec.LaunchOptions[] = [];
  const launch = (_launched: exec.LaunchOptions): Promise<exec.LaunchResult> =>
    Promise.resolve({
      code: null,
      signal: null,
      timedOut: null,
      cancelled: false,
      stderrTail: '',
      cleanup: { confirmed: false, survivors: [], reason: null, containment: { kind: 'none' } },
    });
  const received = (): Received => ({ argv: [], stdin: null });
  const calls = (): (Received & { recording: string })[] => [];
  return {
    launch,
    launches,
    directory: '',
    home: '',
    cwd: '',
    runDirectory: '',
    received,
    calls,
    cliPidFile: '',
    orphanPidFile: '',
  };
}

export type FakeCli = ReturnType<typeof fakeCli>;
