// The Claude CLI's answers as recorded (#427): its no-model commands from test/fixtures/claude/cli-*.json, and a model
// call from a stream recording (#425). `recordedCli` gives them through a launch double in-process, a small test's
// stand-in for the CLI; the fake CLI (child-scripts/fake-claude.ts) prints the same answers from a child process.
import { readFileSync } from 'node:fs';
import type * as exec from '../../lib/exec.ts';

interface RecordedCommand {
  argv: string[];
  exitCode: number;
  stdout: string;
}

const recordedCommand = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/claude/${name}.json`, import.meta.url), 'utf8')) as RecordedCommand;

// The argv of each command doctor's cheap mode may start: none is a model call (#427, decision 2).
export const CHEAP_ARGVS: readonly string[][] = [['--version'], ['auth', 'status', '--json'], ['--help']];

// A version below the pinned minimum, 2.1.328, the version #425's recordings came from.
export const OLD_VERSION = '2.1.327';

// How a case changes the CLI that answers: an executable that cannot start, the version --version prints, the
// logged-out recording for auth status, a change to --help's text, a change to the stream a model call replays,
// the launch profile's, the --bare one's or the --fork-session one's, and the first argument of a command that times
// out printing nothing, that exits 1 printing nothing, or that a signal ends printing nothing (code null, as on POSIX).
export interface CliState {
  missing?: boolean;
  version?: string;
  loggedOut?: boolean;
  help?: (text: string) => string;
  profile?: (stream: string) => string;
  bare?: (stream: string) => string;
  fork?: (stream: string) => string;
  hangs?: string;
  fails?: string;
  killed?: string;
}

const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

// A stream recording's lines, as the CLI printed them.
const recordedStream = (name: string) =>
  readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8');

// A stand-in, not a recording: the success recording as a call under --include-hook-events whose PostToolUse hook ran
// after its first tool and which then handed off. No recording shows a hook (#430, Q5 A: the owner's run of gg doctor
// --probe checks the real CLI), so its two hook lines follow the shape the CLI's SDK names for hook events.
export function handoffStandIn(): string {
  const lines = recordedStream('success')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const sessionId = lines[0]!.session_id;
  const hook = { hook_id: 'hook-1', hook_name: 'PostToolUse:Read', hook_event: 'PostToolUse', session_id: sessionId };
  const additionalContext = 'Context budget: past it, so end with the handed-off Claim and a handoff note.';
  const hookLines = [
    { type: 'system', subtype: 'hook_started', ...hook },
    {
      type: 'system',
      subtype: 'hook_response',
      ...hook,
      output: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }),
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }),
      stderr: '',
      exit_code: 0,
      outcome: 'success',
    },
  ];
  const firstToolResult = lines.findIndex((line) => line.type === 'user');
  const handedOff = lines.map((line) =>
    line.type === 'result'
      ? {
          ...line,
          structured_output: {
            ...(line.structured_output as Record<string, unknown>),
            claim: 'handed-off',
            handoff: 'README.md is read; run slow.js and give the word.',
          },
        }
      : line,
  );
  handedOff.splice(firstToolResult + 1, 0, ...hookLines);
  return `${handedOff.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

// A stand-in, not a recording: the success recording as a copy of its Session under --fork-session, which the CLI
// gives a Session id of its own (#430 D6 A).
export const FORK_SESSION_ID = '00000000-0000-4000-8000-00000000f0c5';
export const forkStandIn = () => {
  const stream = recordedStream('success');
  const sessionId = (JSON.parse(stream.split('\n')[0]!) as { session_id: string }).session_id;
  return stream.replaceAll(sessionId, FORK_SESSION_ID);
};

// What the CLI prints for `args` under `state`, and its exit code. A model call replays the success recording, or the
// hand-off stand-in when it asks for hook events, or the fork stand-in when it forks, and a --bare one the auth-failure
// recording: bare mode reads no OAuth login today (ADR 0002).
function modelCall(args: readonly string[], state: CliState) {
  const same = (stream: string) => stream;
  if (args.includes('--fork-session')) return { stdout: (state.fork ?? same)(forkStandIn()), exitCode: 0 };
  const bare = args.includes('--bare');
  const name = bare ? 'auth-failure' : 'success';
  const edit = (bare ? state.bare : state.profile) ?? same;
  const replayed = !bare && args.includes('--include-hook-events') ? handoffStandIn() : recordedStream(name);
  return { stdout: edit(replayed), exitCode: recordedCommand(name).exitCode };
}

export function answer(args: readonly string[], state: CliState = {}): { stdout: string; exitCode: number } {
  if (args.includes('-p')) return modelCall(args, state);
  const [version, authStatus, help] = CHEAP_ARGVS as [string[], string[], string[]];
  if (sameArgv(args, version)) {
    const { stdout, exitCode } = recordedCommand('cli-version');
    return { stdout: state.version === undefined ? stdout : `${state.version} (Claude Code)\n`, exitCode };
  }
  if (sameArgv(args, authStatus))
    return recordedCommand(state.loggedOut ? 'cli-auth-status-logged-out' : 'cli-auth-status');
  if (sameArgv(args, help)) {
    const { stdout, exitCode } = recordedCommand('cli-help');
    return { stdout: state.help ? state.help(stdout) : stdout, exitCode };
  }
  throw new Error(`the recorded CLI has no answer for claude ${args.join(' ')}`);
}

// The --help text as recorded.
export const recordedHelp = () => recordedCommand('cli-help').stdout;

// A launch that answers each argv in-process as the recorded CLI does, and every launch it was asked for.
export function recordedCli(state: CliState = {}) {
  const launches: exec.LaunchOptions[] = [];
  const launch = async (options: exec.LaunchOptions): Promise<exec.LaunchResult> => {
    launches.push(options);
    if (state.missing) throw Object.assign(new Error(`spawn ${options.command} ENOENT`), { code: 'ENOENT' });
    options.onStarted?.({ kind: 'none' });
    const cleanup = { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' as const } };
    if (state.hangs !== undefined && state.hangs === options.args[0])
      return { code: null, signal: null, timedOut: 'wall', cancelled: false, stderrTail: '', cleanup };
    if (state.fails !== undefined && state.fails === options.args[0])
      return { code: 1, signal: null, timedOut: null, cancelled: false, stderrTail: '', cleanup };
    if (state.killed !== undefined && state.killed === options.args[0])
      return { code: null, signal: 'SIGKILL', timedOut: null, cancelled: false, stderrTail: '', cleanup };
    const { stdout, exitCode } = answer(options.args, state);
    const lines = stdout.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) options.onLine?.(line);
    return { code: exitCode, signal: null, timedOut: null, cancelled: false, stderrTail: '', cleanup };
  };
  return { launch, launches };
}
