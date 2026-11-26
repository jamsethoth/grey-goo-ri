import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cliDoctor from '../../lib/harnesses/cli-doctor.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import * as cliReplay from '../support/cli-replay.ts';

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
