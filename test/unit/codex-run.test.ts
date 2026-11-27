// One Attempt through `codex exec` (#482): the launch profile's files written, the prompt, and the contract's result
// from the stream, the -o file and the rollout, over an in-process launch replaying #479's recorded lines.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codexRun from '../../lib/harnesses/codex-run.ts';
import * as codexStream from '../../lib/harnesses/codex-stream.ts';
import * as cliReplay from '../support/cli-replay.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const FIXTURES = new URL('../fixtures/codex/', import.meta.url);
const THREAD = '01a2044a-1251-7180-8d49-dc1220e52393';
const recorded = (file: string) => readFileSync(new URL(file, FIXTURES), 'utf8');

// gg's Codex home, and a launch replaying the recorded `start` call, which writes its final message to the -o file.
function codexHome(t: TestContext, { prepare }: { prepare?: () => never } = {}) {
  const home = tempDirectory.tempDirectory(t, 'gg-codex-run-');
  const lastMessage = join(home, 'last-message.json');
  const profile = join(home, 'profile.toml');
  const replay = cliReplay.replayLaunch(() => ({ stdout: recorded('start.jsonl'), exitCode: 0 }));
  const runner = {
    launch: (options: Parameters<typeof replay.launch>[0]) => {
      writeFileSync(lastMessage, '{"answer":"heliotrope"}');
      return replay.launch(options);
    },
  };
  const runs: codexRun.Runs = {
    codexHome: home,
    launch: () => {
      prepare?.();
      return Promise.resolve({
        argv: ['exec', '--json'],
        env: { CODEX_HOME: home },
        files: { [profile]: 'profile' },
        lastMessage,
        appsOff: [],
        skills: 'SKILLS',
      });
    },
  };
  return { home, profile, runner, runs, launches: replay.launches };
}

const call = (resume: string | null = null): codexRun.RunCall => ({
  marker: 'marker-1',
  agent: { harness: 'codex', persona: 'reviewer.md', model: 'gpt-6-luna', effort: 'low', access: 'read-only' },
  schema: {},
  cwd: '.',
  resume,
  runDirectory: 'run-1',
  access: 'read-only',
  persona: { bytes: 'PERSONA' },
  brief: 'BRIEF',
  previousUsage: null,
  tools: { plugins: [], mcp: [], hinted: [] },
  timeouts: {},
  env: {},
});

const hooks = { started: () => undefined, signal: new AbortController().signal };

// The rollout of the recorded thread, in a folder of its day under the sessions tree.
function writeRollout(home: string) {
  const directory = join(home, 'sessions', '2026', '11', '22');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-2026-11-22T17-24-53-${THREAD}.jsonl`);
  copyFileSync(new URL('start.rollout.jsonl', FIXTURES), path);
  return path;
}

test("a completed call writes the launch's files, leads with persona and skills, and reads -o", async (t) => {
  const codex = codexHome(t);
  const path = writeRollout(codex.home);
  const { response, result, failure } = await codexRun.run(codex.runner, codex.runs, call(), hooks);
  assert.equal(readFileSync(codex.profile, 'utf8'), 'profile');
  assert.equal(codex.launches[0]?.input, 'PERSONA\n\nSKILLS\n\nBRIEF');
  assert.deepEqual(response, { answer: 'heliotrope' });
  assert.equal(failure, null);
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, THREAD);
  assert.equal(result.transcriptPath, path);
  assert.equal(result.agentCliVersion, '0.171.0');
});

test('a resume sends the Brief alone, and one whose rollout is missing discards its output', async (t) => {
  const codex = codexHome(t);
  const { response, result, failure } = await codexRun.run(codex.runner, codex.runs, call('thread-0'), hooks);
  assert.equal(codex.launches[0]?.input, 'BRIEF');
  assert.equal(response, null);
  assert.equal(result.status, 'failed');
  assert.equal(failure?.failureClass, 'unknown');
  assert.match(failure?.message ?? '', /rollout of resumed thread thread-0 is missing/);
});

// The listings run under the call's cancel signal, so a cancel ends the call there (F15).
test('a call cancelled while its launch lists is killed and starts no command', async (t) => {
  const controller = new AbortController();
  const codex = codexHome(t, {
    prepare: () => {
      controller.abort();
      throw new Error('codex plugin list --json printed no JSON');
    },
  });
  const { response, result, failure } = await codexRun.run(codex.runner, codex.runs, call(), {
    ...hooks,
    signal: controller.signal,
  });
  assert.equal(codex.launches.length, 0);
  assert.equal(response, null);
  assert.deepEqual({ status: result.status, failure }, { status: 'killed', failure: null });
});

test('a launch that cannot be prepared is an unknown failure that started no command', async (t) => {
  const codex = codexHome(t, {
    prepare: () => {
      throw new Error('codex lacks plugin x');
    },
  });
  const { response, result, failure } = await codexRun.run(codex.runner, codex.runs, call(), hooks);
  assert.equal(codex.launches.length, 0);
  assert.equal(response, null);
  assert.deepEqual(
    { status: result.status, sessionId: result.sessionId, failure },
    {
      status: 'failed',
      sessionId: null,
      failure: { failureClass: 'unknown', retryAfterMs: null, message: 'codex lacks plugin x' },
    },
  );
});

// A launch's options and result, as the replay types them (a unit test imports no lib/exec.ts).
type Launch = ReturnType<typeof cliReplay.replayLaunch>['launch'];
type LaunchResult = Awaited<ReturnType<Launch>>;

// A launch that prints `stdout` and ends as `ending` says, writing the -o file's final message as the recorded call
// does.
function endingLaunch(lastMessage: string, stdout: string, ending: Partial<LaunchResult>) {
  return (options: Parameters<Launch>[0]): Promise<LaunchResult> => {
    writeFileSync(lastMessage, '{"answer":"heliotrope"}');
    options.onStarted?.({ kind: 'none' });
    for (const line of stdout.split('\n').filter(Boolean)) options.onLine?.(line);
    const cleanup = { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' as const } };
    return Promise.resolve({
      code: 0,
      signal: null,
      timedOut: null,
      cancelled: false,
      stderrTail: '',
      cleanup,
      ...ending,
    });
  };
}

// Each way a call ends: the stream it printed and what its launch gave.
const failedLine = (message: string) => JSON.stringify({ type: 'turn.failed', error: { message } });
const endings: Record<string, { stdout: string; ending: Partial<LaunchResult> }> = {
  completed: { stdout: recorded('start.jsonl'), ending: {} },
  'timed out on the wall clock': { stdout: '', ending: { code: null, timedOut: 'wall' } },
  'timed out on the stall clock': { stdout: '', ending: { code: null, timedOut: 'stall' } },
  cancelled: { stdout: '', ending: { code: null, cancelled: true } },
  'auth failed': { stdout: recorded('auth-invalid.jsonl'), ending: { code: 1 } },
  'rate-limited': {
    stdout: failedLine('exceeded retry limit, last status: 429 Too Many Requests'),
    ending: { code: 1 },
  },
  transient: { stdout: failedLine('unexpected status 503 Service Unavailable: busy'), ending: { code: 1 } },
};

// DoD 3: a Harness failure is a typed result, never a throw, after the launch too: a sessions tree that cannot be
// read leaves the launch's exit and cleanup in the result. It fails a completed call alone; a timeout, a cancel or a
// classed failure keeps its own status and failure (DoD 2, Q2 A).
test('a rollout that cannot be read is an unknown failure that keeps the launch, never a rejection', async (t) => {
  const faults: Record<string, (home: string, thread: string) => void> = {
    'a sessions path that is a file': (home) => writeFileSync(join(home, 'sessions'), 'not a folder'),
    'a rollout path that is a folder': (home, thread) =>
      mkdirSync(join(home, 'sessions', '2026', `rollout-2026-11-22T17-24-53-${thread}.jsonl`), { recursive: true }),
  };
  const ended: Record<string, unknown> = {};
  for (const [faultName, fault] of Object.entries(faults)) {
    for (const [endingName, { stdout, ending }] of Object.entries(endings)) {
      const codex = codexHome(t);
      fault(codex.home, codexStream.read(stdout.split('\n')).threadId ?? THREAD);
      const runner = { launch: endingLaunch(join(codex.home, 'last-message.json'), stdout, ending) };
      const name = `${faultName}, ${endingName}`;
      try {
        const { response, result, failure } = await codexRun.run(runner, codex.runs, call(THREAD), hooks);
        ended[name] = {
          response,
          status: result.status,
          failureClass: failure?.failureClass ?? null,
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
          confirmed: result.cleanup?.confirmed,
          transcriptPath: result.transcriptPath,
        };
      } catch (err) {
        ended[name] = `rejected: ${(err as Error).message}`;
      }
    }
  }
  const kept = { response: null, exitSignal: null, confirmed: true, transcriptPath: null };
  const expected = {
    completed: { ...kept, status: 'failed', failureClass: 'unknown', exitCode: 0 },
    'timed out on the wall clock': { ...kept, status: 'timed-out', failureClass: null, exitCode: null },
    'timed out on the stall clock': { ...kept, status: 'timed-out', failureClass: null, exitCode: null },
    cancelled: { ...kept, status: 'killed', failureClass: null, exitCode: null },
    'auth failed': { ...kept, status: 'failed', failureClass: 'auth', exitCode: 1 },
    'rate-limited': { ...kept, status: 'failed', failureClass: 'rate-limited', exitCode: 1 },
    transient: { ...kept, status: 'failed', failureClass: 'transient', exitCode: 1 },
  };
  assert.deepEqual(
    ended,
    Object.fromEntries(
      Object.keys(faults).flatMap((faultName) =>
        Object.entries(expected).map(([endingName, value]) => [`${faultName}, ${endingName}`, value]),
      ),
    ),
  );
});

// gg runs Codex under its own Codex home, never the user's (ADR 0031), with the Claude Harness's default limits (#425
// decision 3).
test("a call launches codex in the profile's Codex home with the default limits when it sets none", async (t) => {
  const codex = codexHome(t);
  await codexRun.run(codex.runner, codex.runs, call(), hooks);
  const launch = codex.launches[0];
  assert.deepEqual(
    { command: launch?.command, home: launch?.env?.CODEX_HOME, stallMs: launch?.stallMs, wallMs: launch?.wallMs },
    { command: 'codex', home: codex.home, stallMs: 900_000, wallMs: 7_200_000 },
  );
});

test("a completed call whose CLI wrote no final message never returns an earlier try's", async (t) => {
  const codex = codexHome(t);
  writeFileSync(join(codex.home, 'last-message.json'), '{"answer":"stale"}');
  const replay = cliReplay.replayLaunch(() => ({ stdout: recorded('start.jsonl'), exitCode: 0 }));
  const { response, result } = await codexRun.run(replay, codex.runs, call(), hooks);
  assert.deepEqual({ response, status: result.status }, { response: null, status: 'completed' });
});
