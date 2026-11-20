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
// the launch profile's or the --bare one's, and the first argument of a command that times out printing nothing.
export interface CliState {
  missing?: boolean;
  version?: string;
  loggedOut?: boolean;
  help?: (text: string) => string;
  profile?: (stream: string) => string;
  bare?: (stream: string) => string;
  hangs?: string;
}

const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

// A stream recording's lines, as the CLI printed them.
const recordedStream = (name: string) =>
  readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8');

// What the CLI prints for `args` under `state`, and its exit code. A model call replays the success recording, and a
// --bare one the auth-failure recording: bare mode reads no OAuth login today (ADR 0002).
export function answer(args: readonly string[], state: CliState = {}): { stdout: string; exitCode: number } {
  if (args.includes('-p')) {
    const bare = args.includes('--bare');
    const name = bare ? 'auth-failure' : 'success';
    const edit = (bare ? state.bare : state.profile) ?? ((stream: string) => stream);
    return { stdout: edit(recordedStream(name)), exitCode: recordedCommand(name).exitCode };
  }
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
    if (state.hangs === options.args[0])
      return { code: null, signal: null, timedOut: 'wall', cancelled: false, stderrTail: '', cleanup };
    const { stdout, exitCode } = answer(options.args, state);
    const lines = stdout.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) options.onLine?.(line);
    return { code: exitCode, signal: null, timedOut: null, cancelled: false, stderrTail: '', cleanup };
  };
  return { launch, launches };
}
