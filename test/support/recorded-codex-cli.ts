// The Codex CLI's answers as recorded (#484): its no-model commands from test/fixtures/codex/cli-*.json (#479, and the
// sandbox commands #484 recorded), and a model call from an exec recording (#479). `recordedCodexCli` gives them
// through cli-replay.ts's launch double, in-process, a small test's stand-in for the CLI.
import { readdirSync, readFileSync } from 'node:fs';
import * as cliReplay from './cli-replay.ts';

const FIXTURES = new URL('../fixtures/codex/', import.meta.url);

interface RecordedCommand extends cliReplay.RecordedCommand {
  stderr: string;
}

const recordedCommand = (name: string) =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as RecordedCommand;

// Every recorded no-model command, by its argv after the executable.
export const recordedCommands = (): RecordedCommand[] =>
  readdirSync(FIXTURES)
    .filter((file) => file.startsWith('cli-') && file.endsWith('.json'))
    .map((file) => recordedCommand(file.slice(0, -'.json'.length)));

// The line doctor's sandbox command prints once it ran under MXC.
export const MXC_MARKER = 'GG-MXC-PROBE';

// The recorded MXC command, whose Start-Sleep only held it while its processes were listed: doctor's command is the
// same without it.
const RECORDED_SANDBOX = recordedCommand('cli-sandbox-mxc').argv;
export const SANDBOX_ARGV: readonly string[] = [
  ...RECORDED_SANDBOX.slice(0, -1),
  RECORDED_SANDBOX.at(-1)!.split(';')[0]!,
];

// The argv of each command doctor's cheap mode may start on win32 (the sandbox command only there): none is a model
// call.
export const CHEAP_ARGVS: readonly (readonly string[])[] = [
  ['--version'],
  ['login', 'status'],
  ...(process.platform === 'win32' ? [SANDBOX_ARGV] : []),
];

// Whether a recording answers `args`: one whose argv is the same, or the recorded MXC command for doctor's, which is
// that command less its Start-Sleep.
export const isRecorded = (args: readonly string[]) =>
  recordedCommands().some(({ argv }) => sameArgv(argv, args)) || sameArgv(args, SANDBOX_ARGV);

// A version below the pinned minimum, 0.171.0, the version #479's recordings came from.
export const OLD_VERSION = '0.170.0';

// How a case changes the CLI that answers, beside the launch's own changes: the version --version prints, the
// logged-out recording for login status, the sandbox command failing as an unknown sandbox value did or exiting 0 with
// no marker line as the cmd recording did, the exec recording a model call replays: the profile probe's, and the
// resume probe's, and the one of them whose stream lost its thread.started line; and the MCP servers the server listing
// names in place of the recorded none.
export interface CodexState extends cliReplay.LaunchState {
  version?: string;
  loggedOut?: boolean;
  sandbox?: 'unavailable' | 'no-marker';
  profile?: string;
  resume?: string;
  unthreaded?: 'profile' | 'resume';
  servers?: string[];
}

const sameArgv = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((arg, index) => arg === right[index]);

// An exec recording's stream and exit code.
function modelCall(args: readonly string[], state: CodexState): cliReplay.Answer {
  const call = args.includes('resume') ? 'resume' : 'profile';
  const name = call === 'resume' ? (state.resume ?? 'resume-flags-before') : (state.profile ?? 'start');
  const recorded = readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8');
  const stdout =
    state.unthreaded === call
      ? recorded
          .split('\n')
          .filter((line) => !line.includes('"thread.started"'))
          .join('\n')
      : recorded;
  const { exitCode, stderr } = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as {
    exitCode: number;
    stderr: string;
  };
  return { stdout, stderr, exitCode };
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

// A launch that answers each argv in-process as the recorded Codex CLI does, and every launch it was asked for.
export const recordedCodexCli = (state: CodexState = {}) =>
  cliReplay.replayLaunch((args) => answer(args, state), state);
