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
