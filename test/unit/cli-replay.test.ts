// The in-process CLI double any Harness's small tests launch (#480), over a stand-in CLI that is neither Claude's nor
// Codex's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cliReplay from '../support/cli-replay.ts';

// The stand-in CLI: --version prints its version, and any other argv is a model call that says a line and is done.
const answer = (args: readonly string[]) =>
  args[0] === '--version'
    ? { stdout: 'stand-in 1.0.0\n', exitCode: 0 }
    : { stdout: '{"type":"said"}\n{"type":"done"}\n', exitCode: 3 };

// A launch of `args` over the double, and the lines it printed.
async function launched(state: cliReplay.LaunchState, args: string[]) {
  const { launch, launches } = cliReplay.replayLaunch(answer, state);
  const lines: string[] = [];
  const started: unknown[] = [];
  const ended = await launch({
    command: 'stand-in',
    args,
    onLine: (line) => lines.push(line),
    onStarted: (containment) => started.push(containment),
  });
  return { ended, lines, launches, started };
}

test("the double prints the answer's lines and exits with its code", async () => {
  const { ended, lines, started } = await launched({}, ['run']);
  assert.deepEqual(
    { lines, code: ended.code, timedOut: ended.timedOut, started },
    { lines: ['{"type":"said"}', '{"type":"done"}'], code: 3, timedOut: null, started: [{ kind: 'none' }] },
  );
});

test('the double keeps every launch it was asked for', async () => {
  const { launch, launches } = cliReplay.replayLaunch(answer);
  await launch({ command: 'stand-in', args: ['--version'] });
  await launch({ command: 'stand-in', args: ['run', '--json'] });
  assert.deepEqual(
    launches.map(({ args }) => args),
    [['--version'], ['run', '--json']],
  );
});

test('a missing executable fails to start as spawn does', async () => {
  const { launch } = cliReplay.replayLaunch(answer, { missing: true });
  await assert.rejects(launch({ command: 'stand-in', args: ['--version'] }), { code: 'ENOENT' });
});

test('a command the state hangs ends on the wall clock printing nothing', async () => {
  const { ended, lines } = await launched({ hangs: '--version' }, ['--version']);
  assert.deepEqual({ lines, code: ended.code, timedOut: ended.timedOut }, { lines: [], code: null, timedOut: 'wall' });
});

test('a command the state fails exits 1 printing nothing', async () => {
  const { ended, lines } = await launched({ fails: '--version' }, ['--version']);
  assert.deepEqual({ lines, code: ended.code, signal: ended.signal }, { lines: [], code: 1, signal: null });
});

test('a command the state kills ends on a signal printing nothing', async () => {
  const { ended, lines } = await launched({ killed: 'run' }, ['run']);
  assert.deepEqual({ lines, code: ended.code, signal: ended.signal }, { lines: [], code: null, signal: 'SIGKILL' });
});
