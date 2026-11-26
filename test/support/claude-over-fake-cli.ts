// The Claude Harness over the fake CLI (cli-replay.ts's fakeCli), which replays a recorded call from
// test/fixtures/claude/ at each model call: the same one, or the next of several a case names. Every path the call
// carries holds a space, the fake's own script and recordings included, and each launch checks it unless the case runs
// in a repository of its own. It spawns, so only medium tests call it.
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../../lib/harnesses/claude.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as cliReplay from './cli-replay.ts';
import * as recordedCli from './recorded-cli.ts';

const RECORDINGS = fileURLToPath(new URL('../fixtures/claude', import.meta.url));

// The modes that change the fake's answer to a command that is no model call, as the recorded CLI's state; a model call
// under one replays the recording unchanged.
const COMMAND_STATES: Record<string, recordedCli.CliState> = {
  'old-version': { version: recordedCli.OLD_VERSION },
  'logged-out': { loggedOut: true },
};

export interface FakeCli {
  // The recording the fake replays, by its name in test/fixtures/claude/; with several, each model call replays the
  // next, and any after the last replays the last.
  scenario: string | string[];
  // How the fake changes the replay (child-scripts/fake-cli.ts): `no-result`, `garbage`, `hang`, `hang-no-transcript`
  // or `signal`; or its answer to a command that is no model call: `old-version` or `logged-out`.
  mode?: string;
  // Whether the fake leaves an orphan descendant running, whose pid it writes to orphanPidFile. Its call's stall and
  // wall clocks count from that write, so a stop always comes after the descendant a case checks (#475).
  orphan?: boolean;
  // What the fake writes to its stderr.
  stderr?: string;
  // The executable launched in place of claude, node unless a case names one that does not exist.
  command?: string;
  // Whether each launch checks that the paths it carries hold a space; a case whose calls run in a repository of its
  // own, whose path holds none, turns it off.
  spaced?: boolean;
}

// Where Claude Code writes the transcript of the Session a recording opened: under its configuration directory, in
// projects/<cwd, each non-alphanumeric character as "-">/<session id>.jsonl.
const transcriptOf: cliReplay.TranscriptOf = ({ launched, recording, home }) => {
  const from = `${recording}.jsonl`;
  const [first = '{}'] = readFileSync(from, 'utf8').split('\n').filter(Boolean);
  const { session_id: sessionId } = JSON.parse(first) as { session_id?: string };
  const project = (launched.cwd ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  return sessionId === undefined ? null : { path: join(home, 'projects', project, `${sessionId}.jsonl`), from };
};

// A Claude Harness whose launches start the fake, in a temp directory that holds the Claude configuration directory,
// the repository the call runs in, the Run directory, and the fake's script and recording, copied there.
// The suite's doctor runs no --probe, so no containment probe.
const noProbe = () => Promise.reject(new Error('the fake CLI runs no containment probe'));

export function claudeOverFakeCli(t: TestContext, cli: FakeCli) {
  const { mode = 'replay', ...rest } = cli;
  const commandState = COMMAND_STATES[mode];
  const fake = cliReplay.fakeCli(t, {
    ...rest,
    recordings: RECORDINGS,
    mode: commandState ? 'replay' : mode,
    commands: recordedCli.CHEAP_ARGVS.map((argv) => ({ argv, ...recordedCli.answer(argv, commandState) })),
    resultType: 'result',
    transcript: transcriptOf,
    env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
  });
  const configDirectory = fake.home;
  const harness = {
    ...claude.createClaude({ configDirectory }),
    ...claude.createCli({ launch: fake.launch, childInJob: noProbe }, { configDirectory }),
  };
  const { cwd, runDirectory, received, calls, launches, cliPidFile, orphanPidFile } = fake;
  return { harness, configDirectory, cwd, runDirectory, received, calls, launches, cliPidFile, orphanPidFile };
}

export type ClaudeOverFakeCli = ReturnType<typeof claudeOverFakeCli>;

const AGENT = {
  harness: 'claude',
  persona: 'implementer.md',
  model: 'haiku',
  effort: 'low',
  access: 'workspace-write',
};

// The call gg sends a Harness (docs/interfaces/harness.md, SentCall) for a fresh Attempt in the fake's repository,
// with `changes` over it.
export function claudeCall(fake: ClaudeOverFakeCli, changes: Record<string, unknown> = {}): Record<string, unknown> {
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
    access: 'workspace-write',
    tools: fake.harness.resolveTools(AGENT, { commands: {}, platform: process.platform }),
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
