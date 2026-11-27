// The Codex CLI's answers as recorded (#484): its no-model commands from test/fixtures/codex/cli-*.json (#479, and the
// sandbox commands #484 recorded), and a model call from an exec recording (#479). `recordedCodexCli` gives them
// through cli-replay.ts's launch double, in-process, a small test's stand-in for the CLI.
import { readdirSync, readFileSync } from 'node:fs';
import type * as containmentProbe from '../../lib/containment-probe.ts';
import * as cliReplay from './cli-replay.ts';
import * as codexHookHandlers from './codex-hook-handlers.ts';

const FIXTURES = new URL('../fixtures/codex/', import.meta.url);

interface RecordedCommand extends cliReplay.RecordedCommand {
  stderr: string;
}

// The recorded no-model command `name` (test/fixtures/codex/<name>.json).
export const recordedCommand = (name: string) =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as RecordedCommand;

// Every recorded no-model command, by its argv after the executable.
export const recordedCommands = (): RecordedCommand[] =>
  readdirSync(FIXTURES)
    .filter((file) => file.startsWith('cli-') && file.endsWith('.json'))
    .map((file) => recordedCommand(file.slice(0, -'.json'.length)));

// The line doctor's sandbox command prints once it ran under MXC.
export const MXC_MARKER = 'GG-MXC-PROBE';

// The recorded MXC command, recorded as doctor runs it (#484 D3 A).
export const SANDBOX_ARGV: readonly string[] = recordedCommand('cli-sandbox-mxc').argv;

// The argv of each command doctor's cheap mode may start on win32 (the sandbox command only there): none is a model
// call.
export const CHEAP_ARGVS: readonly (readonly string[])[] = [
  ['--version'],
  ['login', 'status'],
  ...(process.platform === 'win32' ? [SANDBOX_ARGV] : []),
];

// Whether a recording answers `args`: one whose argv is the same.
export const isRecorded = (args: readonly string[]) => recordedCommands().some(({ argv }) => sameArgv(argv, args));

// A version below the pinned minimum, 0.171.0, the version #479's recordings came from.
export const OLD_VERSION = '0.170.0';

// How a case changes the CLI that answers, beside the launch's own changes: the version --version prints, the
// logged-out recording for login status, the sandbox command failing as an unknown sandbox value did or exiting 0 with
// no marker line as the cmd recording did, the exec recording a model call replays: the profile probe's, and the
// resume probe's and the fork probe's, and the one of them whose stream lost its thread.started line, and the one whose
// answer is prose; the MCP servers the server listing names in place of the recorded none; and whether a call carrying
// the hand-off hook keeps its recorded answer, as when the hook stays silent, instead of the hand-off stand-in's.
export interface CodexState extends cliReplay.LaunchState {
  version?: string;
  loggedOut?: boolean;
  sandbox?: 'unavailable' | 'no-marker';
  profile?: string;
  resume?: string;
  fork?: string;
  unthreaded?: ModelCall;
  prose?: ModelCall;
  servers?: string[];
  hookSilent?: boolean;
}

type ModelCall = 'profile' | 'resume' | 'fork';

// The hand-off stand-in's answer (#485 Q2 A): no recording shows a Codex call that handed off, so a call carrying the
// hand-off hook answers as an Agent past its budget does, in the hand-off schema (briefs.handoffSchema).
export const HANDOFF_ANSWER = { answer: 'ok', claim: 'handed-off', handoff: 'README.md is read; nothing remains.' };

// Whether a launch carries the hand-off hook: a PostToolUse command hook in its hooks override, with hooks on.
const carriesHandoffHook = (args: readonly string[]) =>
  args.includes('features.hooks=true') &&
  codexHookHandlers.hookHandlers(args).some(({ event }) => event === 'PostToolUse');

const RECORDED_ANSWER = /"type":"agent_message","text":"(?:[^"\\]|\\.)*"(?=\}\}\s*\n\{"type":"turn\.completed")/;
const answered = (stream: string, answer: unknown) =>
  stream.replace(RECORDED_ANSWER, () => `"type":"agent_message","text":${JSON.stringify(JSON.stringify(answer))}`);

const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

// An exec recording's stream and exit code.
function modelCall(args: readonly string[], state: CodexState): cliReplay.Answer {
  const call = (['resume', 'fork'] as const).find((kind) => args.includes(kind)) ?? 'profile';
  const names = {
    profile: state.profile ?? 'start',
    resume: state.resume ?? 'resume-flags-before',
    fork: state.fork ?? 'fork-kept-read-only',
  };
  const name = names[call];
  const recorded = readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8');
  const threaded =
    state.unthreaded === call
      ? recorded
          .split('\n')
          .filter((line) => !line.includes('"thread.started"'))
          .join('\n')
      : recorded;
  const stdout =
    state.prose === call
      ? threaded.replace(/"type":"agent_message","text":"(?:[^"\\]|\\.)*"/g, '"type":"agent_message","text":"Done."')
      : threaded;
  const handedOff = carriesHandoffHook(args) && !state.hookSilent ? answered(stdout, HANDOFF_ANSWER) : stdout;
  const { exitCode, stderr } = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as {
    exitCode: number;
    stderr: string;
  };
  return { stdout: handedOff, stderr, exitCode };
}

function sandboxAnswer(state: CodexState): cliReplay.Answer {
  if (state.sandbox === 'unavailable') return recordedCommand('cli-sandbox-unknown-value');
  return recordedCommand(state.sandbox === 'no-marker' ? 'cli-sandbox-mxc-no-marker' : 'cli-sandbox-mxc');
}

// The server listing as codex.ts's list starts it; its recording left out the -c, which changes nothing here.
const MCP_LIST_ARGV = ['mcp', 'list', '--json', '-c', 'features.plugins=false'];

function serverListing(state: CodexState): cliReplay.Answer {
  const recorded = recordedCommand('cli-mcp-list');
  if (state.servers === undefined) return recorded;
  return { ...recorded, stdout: JSON.stringify(state.servers.map((name) => ({ name, enabled: true }))) };
}

export function answer(args: readonly string[], state: CodexState = {}): cliReplay.Answer {
  if (args[0] === 'exec') return modelCall(args, state);
  if (sameArgv(args, ['plugin', 'list', '--json'])) return recordedCommand('cli-plugin-list');
  if (sameArgv(args, MCP_LIST_ARGV)) return serverListing(state);
  if (sameArgv(args, ['--version'])) {
    const recorded = recordedCommand('cli-version');
    return state.version === undefined ? recorded : { ...recorded, stdout: `codex-cli ${state.version}\n` };
  }
  if (sameArgv(args, ['login', 'status']))
    return recordedCommand(state.loggedOut ? 'cli-login-status-logged-out' : 'cli-login-status');
  if (sameArgv(args, SANDBOX_ARGV)) return sandboxAnswer(state);
  throw new Error(`the recorded Codex CLI has no answer for codex ${args.join(' ')}`);
}

// #533's one real codex sandbox call, under MXC in the Store's pwsh, started behind the gate in a new job: the lines it
// printed, the pid of the pwsh command's node child, and whether that child was in the job at its line (it was).
interface ContainmentRecording {
  lines: string[];
  childPid: number;
  childInJobAtLine: boolean;
}
export const CONTAINMENT_RECORDING = 'containment-sandbox-mxc-store-pwsh';

// The containment probe as the recording answers it, the child outside gg's job instead when the case `escapes`.
function probedUnderMxc({ escapes = false }: CodexState): containmentProbe.ChildInJob {
  const recorded = JSON.parse(
    readFileSync(new URL(`${CONTAINMENT_RECORDING}.json`, FIXTURES), 'utf8'),
  ) as ContainmentRecording;
  return {
    lines: recorded.lines,
    pid: recorded.childPid,
    inJob: escapes ? false : recorded.childInJobAtLine,
    failure: null,
  };
}

// A launch that answers each argv in-process as the recorded Codex CLI does, and every launch it was asked for; and
// the containment probe, answered by the recording.
export const recordedCodexCli = (state: CodexState = {}) =>
  cliReplay.replayLaunch(
    (args) => answer(args, state),
    state,
    () => probedUnderMxc(state),
  );
