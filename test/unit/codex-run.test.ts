// One Attempt through `codex exec` (#482): the launch profile's files written, the prompt, and the contract's result
// from the stream, the -o file and the rollout, over an in-process launch replaying #479's recorded lines.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codexRun from '../../lib/harnesses/codex-run.ts';
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
  assert.equal(codex.launches[0]?.input, 'PERSONA\nSKILLS\nBRIEF');
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

// DoD 3: a Harness failure is a typed result, never a throw, after the launch too: a sessions tree that cannot be
// read leaves the launch's exit and cleanup in the result.
test('a rollout that cannot be read is an unknown failure that keeps the launch, never a rejection', async (t) => {
  const faults: Record<string, (home: string) => void> = {
    'a sessions path that is a file': (home) => writeFileSync(join(home, 'sessions'), 'not a folder'),
    'a rollout path that is a folder': (home) =>
      mkdirSync(join(home, 'sessions', '2026', `rollout-2026-11-22T17-24-53-${THREAD}.jsonl`), { recursive: true }),
  };
  const ended: Record<string, unknown> = {};
  for (const [name, fault] of Object.entries(faults)) {
    const codex = codexHome(t);
    fault(codex.home);
    try {
      const { response, result, failure } = await codexRun.run(codex.runner, codex.runs, call(THREAD), hooks);
      ended[name] = {
        response,
        status: result.status,
        failureClass: failure?.failureClass,
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        confirmed: result.cleanup?.confirmed,
        transcriptPath: result.transcriptPath,
      };
    } catch (err) {
      ended[name] = `rejected: ${(err as Error).message}`;
    }
  }
  const failed = {
    response: null,
    status: 'failed',
    failureClass: 'unknown',
    exitCode: 0,
    exitSignal: null,
    confirmed: true,
    transcriptPath: null,
  };
  assert.deepEqual(ended, { 'a sessions path that is a file': failed, 'a rollout path that is a folder': failed });
});
