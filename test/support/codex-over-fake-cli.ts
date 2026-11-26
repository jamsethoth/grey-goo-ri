// The Codex Harness over the fake CLI (cli-replay.ts's fakeCli), which replays a recorded `codex exec` call from
// test/fixtures/codex/ (#479) at each model call: the same one, or the next of several a case names. Each call's
// rollout is written where Codex writes it, under the fake's Codex home in sessions/YYYY/MM/DD/, from the recording's
// own rollout, and its final message to the -o file the call names, as Codex writes them. The listings answer as
// recorded (no plugin installed but the recorded catalog's, no MCP server). It spawns, so only medium tests call it.
import type { TestContext } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as exec from '../../lib/exec.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as cliReplay from './cli-replay.ts';
import * as recordedCodexCli from './recorded-codex-cli.ts';
import * as tempDirectory from './temp-directory.ts';

const RECORDINGS = fileURLToPath(new URL('../fixtures/codex', import.meta.url));

// The listings as codex.ts's list starts them, answered as recorded; the server listing's recording left out the -c,
// which changes nothing here.
const LISTINGS: cliReplay.RecordedCommand[] = [
  { ...recordedCodexCli.recordedCommand('cli-plugin-list'), argv: ['plugin', 'list', '--json'] },
  {
    ...recordedCodexCli.recordedCommand('cli-mcp-list'),
    argv: ['mcp', 'list', '--json', '-c', 'features.plugins=false'],
  },
];

export interface FakeCodex {
  // The recording the fake replays, by its name in test/fixtures/codex/; with several, each model call replays the
  // next, and any after the last replays the last.
  scenario: string | string[];
  // How the fake changes the replay (child-scripts/fake-cli.ts): `no-result` (no turn.completed), `garbage`, `hang` or
  // `signal`.
  mode?: string;
  // A change to each replayed stream's text, a stand-in where no recording shows the stream a case needs.
  stream?: (recorded: string) => string;
  // Whether the call's rollout is written; false leaves the sessions tree without it.
  rollout?: boolean;
  // Whether the listings answer; false leaves them to the model call's replay, which prints no listing.
  listings?: boolean;
  // What the fake writes to its stderr.
  stderr?: string;
  // The executable launched in place of codex, node unless a case names one that does not exist.
  command?: string;
  // Whether each launch checks that the paths it carries hold a space; a case whose calls run in a repository of its
  // own, whose path holds none, turns it off.
  spaced?: boolean;
}

interface Recorded {
  scenario: string;
  rolloutPath: string | null;
  lastMessage: string | null;
}

const recordedCall = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Recorded;

// The recordings, or their copies with each stream changed, in a directory of the case's own.
function recordingsFor(t: TestContext, scenarios: string[], stream: FakeCodex['stream']) {
  if (!stream) return RECORDINGS;
  const directory = tempDirectory.tempDirectory(t, 'gg codex recordings-');
  for (const scenario of scenarios) {
    copyFileSync(join(RECORDINGS, `${scenario}.json`), join(directory, `${scenario}.json`));
    const recorded = readFileSync(join(RECORDINGS, `${scenario}.jsonl`), 'utf8');
    writeFileSync(join(directory, `${scenario}.jsonl`), stream(recorded));
  }
  return directory;
}

// Where Codex wrote the recording's rollout, from `sessions` on, under the fake's Codex home; none when the recording
// has no rollout or the case leaves it out.
const rolloutOf =
  (written: boolean): cliReplay.TranscriptOf =>
  ({ recording, home }) => {
    const { scenario, rolloutPath } = recordedCall(`${recording}.json`);
    const from = join(RECORDINGS, `${scenario}.rollout.jsonl`);
    if (!written || rolloutPath === null || !existsSync(from)) return null;
    const parts = rolloutPath.split(/[\\/]/);
    return { path: join(home, ...parts.slice(parts.indexOf('sessions'))), from };
  };

// The launch that writes the replayed recording's final message to the call's -o file once the fake has exited, as
// Codex writes it at the turn's end; a stopped call, and a recording with none, write nothing.
function withLastMessage(fake: cliReplay.FakeCli, scenarios: string[], mode: string) {
  let modelCalls = 0;
  return async (options: exec.LaunchOptions) => {
    const ended = await fake.launch(options);
    if (options.args[0] !== 'exec') return ended;
    const scenario = scenarios[Math.min(modelCalls++, scenarios.length - 1)]!;
    const { lastMessage } = recordedCall(join(RECORDINGS, `${scenario}.json`));
    const output = options.args[options.args.indexOf('-o') + 1];
    if (['replay', 'garbage'].includes(mode) && lastMessage && output) writeFileSync(output, lastMessage);
    return ended;
  };
}

// A Codex Harness whose launches start the fake, in a temp directory that holds gg's Codex home, the user's skills
// folder, the repository the call runs in, the Run directory, and the fake's script and recording, copied there.
export function codexOverFakeCli(t: TestContext, cli: FakeCodex) {
  const { mode = 'replay', stream, rollout = true, listings = true, ...rest } = cli;
  const scenarios = [cli.scenario].flat();
  const fake = cliReplay.fakeCli(t, {
    ...rest,
    recordings: recordingsFor(t, scenarios, stream),
    mode,
    commands: listings ? LISTINGS : [],
    resultType: 'turn.completed',
    transcript: rolloutOf(rollout),
    env: (home) => ({ CODEX_HOME: home }),
  });
  const codexHome = fake.home;
  const skillsHome = join(fake.directory, 'skills');
  mkdirSync(skillsHome);
  const launch = withLastMessage(fake, scenarios, mode);
  const homes = { codexHome, skillsHome };
  const harness = { ...codex.createCodex(homes), ...codex.createCli({ launch }, homes) };
  const { cwd, runDirectory, received, calls, launches } = fake;
  return { harness, codexHome, skillsHome, cwd, runDirectory, received, calls, launches };
}

export type CodexOverFakeCli = ReturnType<typeof codexOverFakeCli>;

const AGENT = {
  harness: 'codex',
  persona: 'implementer.md',
  model: 'gpt-6-luna',
  effort: 'low',
  access: 'read-only',
};

// The call gg sends a Harness (docs/interfaces/harness.md, SentCall) for a fresh Attempt in the fake's repository,
// with `changes` over it.
export function codexCall(fake: CodexOverFakeCli, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    marker: 'gg:e1:implement:1:work:0:r1:1',
    vertex: 'implement',
    visit: 1,
    phase: 'work',
    attempt: 1,
    agent: AGENT,
    persona: { name: 'implementer.md', bytes: 'You are the implementer.\n', hash: 'a'.repeat(64) },
    brief: 'Read README.md and answer with the word it names.',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    cwd: fake.cwd,
    resume: null,
    previousUsage: null,
    runDirectory: fake.runDirectory,
    access: 'read-only',
    tools: fake.harness.resolveTools(AGENT),
    timeouts: {},
    env: {},
    ...changes,
  };
}

// The hooks gg passes a call: `started` is told what contains it, and `signal` aborts it.
export function hooksOf({
  started = () => {},
  signal = new AbortController().signal,
}: Partial<runContext.HarnessHooks> = {}): runContext.HarnessHooks {
  return { started, signal };
}
