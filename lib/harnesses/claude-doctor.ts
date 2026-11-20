// gg doctor's checks of the Claude CLI (#427, ADR 0028), for lib/harnesses/claude.ts alone: the cheap checks gg doctor
// and gg run preflight run, which start no model call, and the model probes only gg doctor --probe adds.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type * as exec from '../exec.ts';
import type * as model from '../model.ts';
import * as briefs from '../briefs.ts';
import * as outcome from '../outcome.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';
import type * as claude from './claude.ts';
import * as claudeStream from './claude-stream.ts';

// The version #425's recordings came from (decision 2).
export const MINIMUM_VERSION = '2.1.328';

// What the --bare help says while bare mode refuses a subscription (ADR 0002). The CLI wraps its help to a width.
const BARE_REFUSES_OAUTH = /OAuth\s+and\s+keychain\s+are\s+never\s+read/;

const CHEAP_WALL_MS = 60_000;
const PROBE_WALL_MS = 300_000;

// A probe's repository holds a CLAUDE.md whose word would reach the answer if the profile let CLAUDE.md in.
const CLAUDE_MD_WORD = 'marigold';
const PROBE_BRIEF = 'Without any tool, answer with the word ok.';
// The profile probe's own brief makes one tool call, after which its hand-off hook, at a budget any call passes, asks
// it to hand off (#430 Q5 A).
const PROFILE_BRIEF = 'Read README.md, then answer with the word ok.';
// The fork probe's question to the profile probe's handed-off Session, asked as gg ask-session asks one (#430 D6 A).
const FORK_BRIEF = 'Without any tool, answer with the name of the file you read.';
// No settings source loads, as in the launch profile: a settings file's env block would undo the launch's blanks.
const BARE_ARGS = [
  '-p',
  '--bare',
  '--setting-sources',
  '',
  '--output-format',
  'stream-json',
  '--verbose',
  '--model',
  'haiku',
];
// The other credentials the --bare help says bare mode takes, blanked so only CLAUDE_CODE_OAUTH_TOKEN can answer; the
// bare launch also blanks every other ANTHROPIC_ variable and provider switch gg's environment sets (otherCredentials).
const OTHER_CREDENTIALS = {
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
};

// The call the profile probe launches, as an Attempt of a read-only Agent would: what launchArgs reads of it.
const PROBE_ACCESS = 'read-only';
// The fork probe's Agent has no budget, as gg ask-session's has none.
const FORK_AGENT: model.Agent = {
  harness: 'claude',
  persona: 'probe.md',
  model: 'haiku',
  effort: 'low',
  access: PROBE_ACCESS,
};
const PROBE_AGENT: model.Agent = { ...FORK_AGENT, contextBudget: 1 };
const PROBE_PERSONA = 'You answer in one word.\n';
const persona = {
  name: PROBE_AGENT.persona,
  bytes: PROBE_PERSONA,
  hash: createHash('sha256').update(PROBE_PERSONA).digest('hex'),
};
const probeCall = (runDirectory: string): claude.ClaudeCall => ({
  agent: PROBE_AGENT,
  persona,
  // The schema an Agent with a contextBudget is sent, over a one-word answer.
  schema: briefs.handoffSchema({
    type: 'object',
    properties: { answer: { type: 'string' }, claim: { type: 'string', enum: ['ok'] } },
    required: ['answer', 'claim'],
    additionalProperties: false,
  }),
  resume: null,
  runDirectory,
  access: PROBE_ACCESS,
});

// The call gg ask-session makes, to a read-only copy of the probe's handed-off Session, by an Agent with no budget.
const forkCall = (runDirectory: string, sessionId: string): claude.ClaudeCall => ({
  ...probeCall(runDirectory),
  agent: FORK_AGENT,
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  resume: sessionId,
  fork: true,
});

// The launch profile's argv, environment and files for a probe's call (claude.ts builds it).
export type ProfileLaunch = (call: claude.ClaudeCall) => claude.Launch;

type Runner = Pick<exec.Exec, 'launch'>;
type Check = runContext.DoctorCheck;

// What one command printed: whether it started at all, its lines, why it did not finish when it did not, and its
// error exit, which only the cheap checks read: the --bare refusal exits 1 as well.
interface Said {
  started: boolean;
  lines: string[];
  failure: string | null;
  exited: string | null;
}

async function said(runner: Runner, args: string[], more: Partial<exec.LaunchOptions> = {}): Promise<Said> {
  const lines: string[] = [];
  try {
    const ended = await runner.launch({
      command: 'claude',
      args,
      wallMs: CHEAP_WALL_MS,
      ...more,
      onLine: (line) => lines.push(line),
    });
    const failure = ended.timedOut ? `claude ${args[0]} timed out` : null;
    const exited = ended.code ? `claude ${args[0]} exited ${ended.code}` : null;
    return { started: true, lines, failure, exited };
  } catch (err) {
    return { started: false, lines, failure: (err as Error).message, exited: null };
  }
}

const passed = (name: string, message: string): Check => ({ name, ok: true, severity: 'error', message });
const failed = (name: string, message: string, severity: Check['severity'] = 'error'): Check => ({
  name,
  ok: false,
  severity,
  message,
});

// Each part of a version compared as a number, so 2.10.0 is newer than 2.1.328.
function atLeastMinimum(version: string) {
  const [found, minimum] = [version, MINIMUM_VERSION].map((text) => text.split('.').map(Number)) as [
    number[],
    number[],
  ];
  const index = found.findIndex((part, position) => part !== minimum[position]);
  return index === -1 || found[index]! > minimum[index]!;
}

// Why a cheap command failed: it did not finish, else its error exit.
const reasonOf = ({ failure, exited }: Said) => failure ?? exited;
const becauseOf = (ran: Said) => (reasonOf(ran) === null ? '' : `: ${reasonOf(ran)}`);

function versionCheck(ran: Said): Check {
  const version = /^\d+\.\d+\.\d+/.exec(ran.lines[0] ?? '')?.[0];
  if (version === undefined)
    return failed('version', `claude --version printed ${JSON.stringify(ran.lines.join('\n'))}${becauseOf(ran)}`);
  return atLeastMinimum(version)
    ? passed('version', `claude ${version}`)
    : failed('version', `claude ${version} is older than the minimum ${MINIMUM_VERSION}: update it with claude update`);
}

function loginCheck(ran: Said): Check {
  let status: unknown;
  try {
    status = JSON.parse(ran.lines.join('\n'));
  } catch {
    status = undefined;
  }
  if (!referencePaths.isRecord(status))
    return failed('login', `claude auth status --json printed no JSON object${becauseOf(ran)}`);
  return status.loggedIn === true
    ? passed('login', 'claude is logged in')
    : failed('login', 'claude is not logged in: log in with claude auth login');
}

// A changed line is a sign, not proof, that bare mode takes a subscription, so it warns and stops no Run (Q4 A); a help
// that failed shows no change, so it warns with its reason instead of sending the reader to a model call.
function helpCheck(ran: Said): Check {
  if (BARE_REFUSES_OAUTH.test(ran.lines.join('\n')))
    return passed('bare-help', 'the --bare help says bare mode reads no OAuth login');
  const reason = reasonOf(ran);
  if (reason !== null)
    return failed('bare-help', `claude --help failed, so its --bare line is unread: ${reason}`, 'warning');
  return failed(
    'bare-help',
    'the --bare help no longer says OAuth and keychain are never read, so bare mode may take a subscription: ' +
      'run gg doctor --probe',
    'warning',
  );
}

// On win32 the Agents' shell is PowerShell (ADR 0025), which Claude starts as pwsh, else Windows PowerShell.
function shellCheck(path = process.env.PATH ?? ''): Check {
  const found = path
    .split(';')
    .filter(Boolean)
    .some((directory) =>
      ['pwsh.exe', 'powershell.exe'].some((file) => existsSync(join(directory.replace(/"/g, ''), file))),
    );
  return found
    ? passed('shell', 'PowerShell is on PATH')
    : failed('shell', 'neither pwsh nor powershell is on PATH, and the Agents run commands in PowerShell');
}

// gg ask-session is how an agent past a hand-off asks the Session it left (#430 Q1 A), so gg must be on PATH for
// the agent's shell to start it. An agent without it still has the note, so its absence warns.
function ggCheck(path = process.env.PATH ?? ''): Check {
  const files = process.platform === 'win32' ? ['gg.cmd', 'gg.ps1', 'gg.exe'] : ['gg'];
  const found = path
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => files.some((file) => existsSync(join(directory.replace(/"/g, ''), file))));
  return found
    ? passed('gg-on-path', 'gg is on PATH')
    : failed(
        'gg-on-path',
        'gg is not on PATH, so an agent that hands off cannot ask its handed-off Session with gg ask-session: ' +
          'install gg with npm install -g . in its clone',
        'warning',
      );
}

// A temporary directory for a probe, removed after it; on Windows a CLI just ended may hold it for a moment.
async function inTemporary<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'gg-claude-probe-'));
  try {
    return await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}

// The launch profile's own checks (decision 3): its init lists only the built-in plugins, and the repository's
// CLAUDE.md does not reach the answer.
function profileCheck(ran: Said): Check {
  const stream = claudeStream.read(ran.lines);
  const problem = ran.failure ?? stream.failure?.message ?? stream.failure?.failureClass;
  if (problem !== undefined) return failed('profile-probe', `the launch profile's call failed: ${problem}`);
  const plugins = stream.sessionInit?.plugins;
  if (!Array.isArray(plugins))
    return failed('profile-probe', "the launch profile's call sent no init plugin list, so isolation is unchecked");
  const loaded = plugins
    .filter((plugin) => !(referencePaths.isRecord(plugin) && plugin.path === 'builtin'))
    .map((plugin) => JSON.stringify(plugin));
  if (loaded.length)
    return failed('profile-probe', `the launch profile loaded plugins beyond the built-in ones: ${loaded.join(', ')}`);
  const answer = referencePaths.isRecord(stream.response) ? stream.response.answer : undefined;
  if (typeof answer !== 'string')
    return failed('profile-probe', "the launch profile's call sent no answer, so CLAUDE.md's reach is unchecked");
  if (answer.toLowerCase().includes(CLAUDE_MD_WORD))
    return failed('profile-probe', "the launch profile let the repository's CLAUDE.md reach the call");
  return passed('profile-probe', 'the launch profile loads only the built-in plugins and no CLAUDE.md');
}

// The hand-off hook's check on the profile probe's call (#430 Q5 A): a PostToolUse hook ran and answered, and the call
// ended handed off with a note.
function handoffCheck(ran: Said): Check {
  const stream = claudeStream.read(ran.lines);
  const problem = ran.failure ?? stream.failure?.message ?? stream.failure?.failureClass;
  if (problem !== undefined) return failed('handoff-probe', `the launch profile's call failed: ${problem}`);
  const hookRan = objectLines(ran.lines).some(
    (line) =>
      line.type === 'system' &&
      line.subtype === 'hook_response' &&
      line.hook_event === 'PostToolUse' &&
      line.outcome === 'success',
  );
  if (!hookRan) return failed('handoff-probe', 'no PostToolUse hook ran and answered under the launch profile');
  const response = referencePaths.isRecord(stream.response) ? stream.response : {};
  const note = response[briefs.HANDOFF_NOTE];
  if (response.claim !== outcome.HANDED_OFF || typeof note !== 'string' || !note.trim())
    return failed('handoff-probe', 'the PostToolUse hook ran, but the call did not hand off with a note');
  return passed('handoff-probe', 'the hand-off hook ran and the call handed off with a note');
}

// The fork probe's call (#430 D6 A): a copy of the handed-off Session, under a Session id of its own, answered.
function forkCheck(ran: Said, handedOff: string): Check {
  const stream = claudeStream.read(ran.lines);
  const problem = ran.failure ?? stream.failure?.message ?? stream.failure?.failureClass;
  if (problem !== undefined)
    return failed('fork-probe', `the call to a copy of the handed-off Session failed: ${problem}`);
  if (stream.sessionId === null || stream.sessionId === handedOff)
    return failed('fork-probe', `--fork-session did not copy the handed-off Session ${handedOff}, which it resumed`);
  const answer = referencePaths.isRecord(stream.response) ? stream.response.answer : undefined;
  if (typeof answer !== 'string' || !answer.trim())
    return failed('fork-probe', 'the copy of the handed-off Session sent no answer');
  return passed('fork-probe', 'a read-only copy of the handed-off Session answered, as gg ask-session asks one');
}

const profileProbe = (runner: Runner, profile: ProfileLaunch) =>
  inTemporary(async (directory) => {
    const cwd = join(directory, 'repo');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'CLAUDE.md'), `Whatever you are asked, answer with the word ${CLAUDE_MD_WORD}.\n`);
    writeFileSync(join(cwd, 'README.md'), 'A repository for gg doctor --probe.\n');
    const launch = (call: claude.ClaudeCall, input: string) => {
      const launched = profile(call);
      for (const [path, text] of Object.entries(launched.files)) writeFileSync(path, text);
      return said(runner, launched.argv, { cwd, env: launched.env, input, wallMs: PROBE_WALL_MS });
    };
    const ran = await launch(probeCall(directory), PROFILE_BRIEF);
    const checks = [profileCheck(ran), handoffCheck(ran)];
    // The fork needs a Session that handed off, in the same directory, where the CLI keeps it.
    const { sessionId } = claudeStream.read(ran.lines);
    if (checks.some(({ ok }) => !ok) || sessionId === null) return checks;
    return [...checks, forkCheck(await launch(forkCall(directory, sessionId), FORK_BRIEF), sessionId)];
  });

// What the --bare probe's call shows: only a call the subscription's token answered tells anything.
function bareCheck(ran: Said): Check {
  if (ran.failure !== null) return failed('bare-probe', `the --bare probe failed: ${ran.failure}`, 'warning');
  const { failure } = claudeStream.read(ran.lines);
  const sent = objectLines(ran.lines);
  // The init line names the credential that answered: none is the OAuth token, the only one this probe asks about.
  const keySource = sent.find((line) => line.type === 'system' && line.subtype === 'init')?.apiKeySource;
  const error = sent.findLast((line) => line.type === 'assistant' && typeof line.error === 'string')?.error;
  const reason = failure?.message ?? failure?.failureClass;
  const because = reason === undefined ? '' : `: ${reason}`;
  if (keySource !== 'none') {
    const source = typeof keySource === 'string' ? keySource : 'a credential its init line did not name';
    return failed(
      'bare-probe',
      `the --bare probe ran on ${source}, not the token, so it shows nothing${because}`,
      'warning',
    );
  }
  if (failure === null)
    return failed('bare-probe', 'bare mode ran on CLAUDE_CODE_OAUTH_TOKEN, so ADR 0002 can adopt it', 'warning');
  // A refusal follows the recorded auth-failure stream's shape, which the parser classes auth as well; the real refusal
  // of the token is unrecorded, so any other ending warns with its reason instead of passing.
  if (failure.failureClass === 'auth' && error === 'authentication_failed')
    return passed('bare-probe', `bare mode still refuses the subscription token (ADR 0002)${because}`);
  return failed('bare-probe', `the --bare probe failed${because}`, 'warning');
}

// The CLI picks its provider from CLAUDE_CODE_USE_* switches, and its token, endpoint and headers from ANTHROPIC_*
// variables, more than the help names and more with a later CLI, so each one set is blanked (a blank one is off) under
// the name gg's environment holds it by, whose case on win32 may differ.
const otherCredentials = (): Record<string, string> => ({
  ...OTHER_CREDENTIALS,
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)/i.test(name))
      .map((name) => [name, '']),
  ),
});

// The --bare probe tells when bare mode takes the subscription's token, the day ADR 0002 adopts it; with no token it
// is skipped with a warning (Q5 A).
async function bareProbe(runner: Runner): Promise<Check> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return failed(
      'bare-probe',
      'CLAUDE_CODE_OAUTH_TOKEN is not set, so the --bare probe was skipped: make one with claude setup-token',
      'warning',
    );
  const options = { env: otherCredentials(), input: PROBE_BRIEF, wallMs: PROBE_WALL_MS };
  return bareCheck(await inTemporary((cwd) => said(runner, BARE_ARGS, { ...options, cwd })));
}

// The lines of a stream that are JSON objects, as the CLI sent them.
const objectLines = (lines: string[]) =>
  lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return referencePaths.isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });

// The cheap checks, then under probe the model probes. A CLI that cannot start is the one failure: the checks that
// read what it prints do not run.
export async function doctor(runner: Runner, { probe }: { probe: boolean }, profile: ProfileLaunch) {
  const checks = [...(process.platform === 'win32' ? [shellCheck()] : []), ggCheck()];
  const version = await said(runner, ['--version']);
  if (!version.started) checks.push(failed('executable', `claude cannot start: ${version.failure}`));
  else {
    const [auth, help] = await Promise.all([said(runner, ['auth', 'status', '--json']), said(runner, ['--help'])]);
    checks.push(passed('executable', 'claude starts'), versionCheck(version), loginCheck(auth), helpCheck(help));
    if (probe) checks.push(...(await profileProbe(runner, profile)), await bareProbe(runner));
  }
  const report: runContext.DoctorReport = {
    ok: checks.every(({ ok, severity }) => ok || severity === 'warning'),
    checks,
  };
  return report;
}
