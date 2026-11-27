import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as cliDoctor from '../../lib/harnesses/cli-doctor.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import * as cliReplay from '../support/cli-replay.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const START = new URL('../fixtures/codex/start.jsonl', import.meta.url);

// The Codex Harness's listings of gg's Codex home (#481 Q2 A), beside codex-harness.test.ts, which is at its line cap.

// The plugin listing reads OpenAI's catalog and once took 87 s, so neither listing runs under the cheap limit (F16).
test('each listing runs under the probe wall limit, not the cheap one', async () => {
  const cli = cliReplay.replayLaunch((args) => ({
    stdout: args[0] === 'plugin' ? '{"installed":[]}' : '[]',
    exitCode: 0,
  }));
  await codex.list(cli, 'codex-home');
  assert.deepEqual(
    cli.launches.map(({ wallMs }) => wallMs),
    [cliDoctor.PROBE_WALL_MS, cliDoctor.PROBE_WALL_MS],
  );
});

// A cancel of the call stops its listings at once, not after their wall limit (F15).
test("each listing runs under the call's cancel signal", async () => {
  const cli = cliReplay.replayLaunch((args) => ({
    stdout: args[0] === 'plugin' ? '{"installed":[]}' : '[]',
    exitCode: 0,
  }));
  const { signal } = new AbortController();
  await codex.list(cli, 'codex-home', signal);
  assert.deepEqual(
    cli.launches.map((launch) => launch.signal),
    [signal, signal],
  );
});

// A plugin's servers stay out of the server listing, as feature-flow listed them (#481 D9 B).
test('the plugin listing runs as is and the server listing with the plugins feature off', async () => {
  const cli = cliReplay.replayLaunch((args) => ({
    stdout: args[0] === 'plugin' ? '{"installed":[]}' : '[]',
    exitCode: 0,
  }));
  await codex.list(cli, 'codex-home');
  assert.deepEqual(cli.launches.map(({ args }) => args).sort(), [
    ['mcp', 'list', '--json', '-c', 'features.plugins=false'],
    ['plugin', 'list', '--json'],
  ]);
});

// Each call lists afresh before it spawns, so a plugin gone since preflight fails that call (ADR 0031 point 7, D3 A).
test("a call's run lists both before it starts codex exec, and the later slices' members throw", async (t) => {
  const home = tempDirectory.tempDirectory(t, 'gg-codex-listings-');
  const cli = cliReplay.replayLaunch((args) => ({
    stdout: { plugin: '{"installed":[]}', mcp: '[]' }[args[0] ?? ''] ?? readFileSync(START, 'utf8'),
    exitCode: 0,
  }));
  const harness = codex.createCli(cli, { codexHome: home, skillsHome: home });
  const agent = { harness: 'codex', persona: 'reviewer.md', model: 'gpt-6-luna', effort: 'low', access: 'read-only' };
  const call = { marker: 'marker-1', agent, schema: {}, cwd: '.', resume: null, runDirectory: home };
  const sent = { ...call, access: 'read-only', persona: { bytes: 'PERSONA' }, brief: 'BRIEF', previousUsage: null };
  const tools = { plugins: [], mcp: [], hinted: [] };
  const hooks = { started: () => undefined, signal: new AbortController().signal };
  await harness.run({ ...sent, tools, timeouts: {}, env: {} }, hooks);
  assert.deepEqual(
    cli.launches.map(({ args }) => args[0]),
    ['plugin', 'mcp', 'exec'],
  );
  assert.throws(() => harness.interactiveArgs({}, 'opening'), { message: 'not implemented' });
  assert.throws(() => harness.metrics('thread-0'), { message: 'not implemented' });
});
