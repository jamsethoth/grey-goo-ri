// The Claude Harness over the fake claude CLI (child-scripts/fake-claude.ts): gg's real launch, with the command it
// starts replaced by node running the fake, which replays one recorded call. It spawns, so only medium tests call it.
import type { TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exec from '../../lib/exec.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as tempDirectory from './temp-directory.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./child-scripts/fake-claude.ts', import.meta.url));
const { launch } = exec.createExec();

export interface FakeCli {
  // The recording the fake replays, by its name in test/fixtures/claude/.
  scenario: string;
  // How the fake changes the replay (fake-claude.ts): `no-result`, `garbage` or `hang`.
  mode?: string;
  // The executable launched in place of claude, node unless a case names one that does not exist.
  command?: string;
}

// A Claude Harness whose launches start the fake, in a temp directory that holds the Claude configuration directory,
// the repository the call runs in and the Run directory.
export function claudeOverFakeCli(t: TestContext, { scenario, mode = 'replay', command = process.execPath }: FakeCli) {
  const directory = tempDirectory.tempDirectory(t, 'gg-fake-claude-');
  const [configDirectory, cwd, runDirectory] = ['claude-home', 'repo', 'run'].map((name) => join(directory, name)) as [
    string,
    string,
    string,
  ];
  for (const made of [configDirectory, cwd, runDirectory]) mkdirSync(made);
  const receivedFile = join(directory, 'received.json');
  // What the Harness asked launch for, each call's options as it passed them.
  const launches: exec.LaunchOptions[] = [];
  const overFake = (options: exec.LaunchOptions) => {
    launches.push(options);
    return launch({
      ...options,
      command,
      args: [FAKE_CLAUDE, ...options.args],
      env: {
        ...options.env,
        CLAUDE_CONFIG_DIR: configDirectory,
        FAKE_CLAUDE_SCENARIO: scenario,
        FAKE_CLAUDE_MODE: mode,
        FAKE_CLAUDE_RECEIVED: receivedFile,
      },
    });
  };
  const harness = {
    ...claude.createClaude({ configDirectory }),
    ...claude.createCli({ launch: overFake }, { configDirectory }),
  };
  // What the fake read: its argv after the executable, and its stdin; nothing when it never ran.
  const received = (): { argv: string[]; stdin: string | null } =>
    existsSync(receivedFile)
      ? (JSON.parse(readFileSync(receivedFile, 'utf8')) as { argv: string[]; stdin: string })
      : { argv: [], stdin: null };
  return { harness, configDirectory, cwd, runDirectory, received, launches };
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
