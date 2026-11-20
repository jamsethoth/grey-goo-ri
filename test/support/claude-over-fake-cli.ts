// The Claude Harness over the fake claude CLI (child-scripts/fake-claude.ts): gg's real launch, with the command it
// starts replaced by node running the fake, which replays one recorded call. Every path the call carries holds a
// space, the fake's own script and recording included, and each launch checks it. It spawns, so only medium tests call
// it.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exec from '../../lib/exec.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as processProbe from './process-probe.ts';
import * as tempDirectory from './temp-directory.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./child-scripts/fake-claude.ts', import.meta.url));
const RECORDINGS = fileURLToPath(new URL('../fixtures/claude', import.meta.url));
const { launch } = exec.createExec();

export interface FakeCli {
  // The recording the fake replays, by its name in test/fixtures/claude/.
  scenario: string;
  // How the fake changes the replay (fake-claude.ts): `no-result`, `garbage`, `hang`, `hang-no-transcript` or
  // `signal`.
  mode?: string;
  // Whether the fake leaves an orphan descendant running, whose pid it writes to orphanPidFile.
  orphan?: boolean;
  // What the fake writes to its stderr.
  stderr?: string;
  // The executable launched in place of claude, node unless a case names one that does not exist.
  command?: string;
}

// Every absolute path a launch carries whole as its working directory, an argv entry or an environment value, the
// Harness's and the fake's, holds a space (#426); a path inside a flag value, JSON or a file is not checked. The
// spaces case names each role, which catches one turned relative. The command is node, claude's stand-in.
function assertSpaced(launched: exec.LaunchOptions) {
  for (const carried of [launched.cwd ?? '', ...launched.args, ...Object.values(launched.env ?? {})])
    assert.ok(
      !isAbsolute(carried) || carried.includes(' '),
      `the path ${carried} a Claude call carries holds no space`,
    );
}

// A Claude Harness whose launches start the fake, in a temp directory that holds the Claude configuration directory,
// the repository the call runs in, the Run directory, and the fake's script and recording, copied there.
export function claudeOverFakeCli(t: TestContext, cli: FakeCli) {
  const { scenario, mode = 'replay', command = process.execPath, orphan = false, stderr } = cli;
  // On Windows a fake just killed holds its working directory for a moment, so the repository goes first, with retries;
  // any process of the fake's left running, which a failed case can leave, is ended before it.
  const removeRepository = () => {
    for (const pidFile of [cliPidFile, orphanPidFile]) processProbe.endProcessIn(pidFile);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  };
  const directory = tempDirectory.tempDirectory(t, 'gg fake claude-', undefined, removeRepository);
  const [configDirectory, cwd, runDirectory] = ['claude-home', 'repo', 'run'].map((name) => join(directory, name)) as [
    string,
    string,
    string,
  ];
  for (const made of [configDirectory, cwd, runDirectory]) mkdirSync(made);
  const receivedFile = join(directory, 'received.json');
  const [cliPidFile, orphanPidFile] = [join(directory, 'cli.pid'), join(directory, 'orphan.pid')];
  // .mts, so node runs the copy as a module whatever package.json lies above the temp directory
  const fakeScript = join(directory, 'fake claude.mts');
  copyFileSync(FAKE_CLAUDE, fakeScript);
  const recording = join(directory, 'the recording');
  for (const extension of ['.json', '.jsonl'])
    copyFileSync(`${RECORDINGS}/${scenario}${extension}`, recording + extension);
  // What the Harness asked launch for, each call's options as it passed them.
  const launches: exec.LaunchOptions[] = [];
  const overFake = (options: exec.LaunchOptions) => {
    launches.push(options);
    const launched = {
      ...options,
      command,
      args: [fakeScript, ...options.args],
      env: {
        ...options.env,
        CLAUDE_CONFIG_DIR: configDirectory,
        FAKE_CLAUDE_RECORDING: recording,
        FAKE_CLAUDE_MODE: mode,
        FAKE_CLAUDE_RECEIVED: receivedFile,
        FAKE_CLAUDE_PID: cliPidFile,
        ...(orphan && { FAKE_CLAUDE_ORPHAN: orphanPidFile }),
        ...(stderr !== undefined && { FAKE_CLAUDE_STDERR: stderr }),
      },
    };
    assertSpaced(launched);
    return launch(launched);
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
  return { harness, configDirectory, cwd, runDirectory, received, launches, cliPidFile, orphanPidFile };
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
