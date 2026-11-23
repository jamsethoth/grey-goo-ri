// One Agent CLI call (#480): its stops, its cancel and its failure at exit, over a launch double and a stand-in stream
// that is neither Claude's nor Codex's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cliCall from '../../lib/harnesses/cli-call.ts';

// The launch the module is handed, as a small test may name it without importing lib/exec.ts.
type Runner = Parameters<typeof cliCall.run>[0];
type LaunchResult = Awaited<ReturnType<Runner['launch']>>;

// The stand-in CLI's stream: a line per event, which ends well only with a done line.
const SAID = '{"event":"said","text":"working"}';
const DONE = '{"event":"done"}';
const readStandIn = (lines: string[]) => ({
  lines,
  failure: lines.includes(DONE)
    ? null
    : { failureClass: 'unknown', message: 'the stand-in stream ended with no done line' },
});

const CLEANUP = { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' as const } };
const EXITED: LaunchResult = {
  code: 0,
  signal: null,
  timedOut: null,
  cancelled: false,
  stderrTail: '',
  cleanup: CLEANUP,
};

// A launch double: the CLI prints `lines`, then stays silent for `silentMs`, which the stall clock stops when it is
// past stallMs, then ends as `ended` says; a call whose signal was aborted ends cancelled.
const launcher = ({
  lines,
  silentMs = 0,
  ended = {},
}: {
  lines: string[];
  silentMs?: number;
  ended?: Partial<LaunchResult>;
}): Runner => ({
  launch: (options) => {
    for (const line of lines) options.onLine?.(line);
    if (options.signal?.aborted === true) return Promise.resolve({ ...EXITED, code: null, cancelled: true });
    if (options.stallMs !== undefined && silentMs > options.stallMs)
      return Promise.resolve({ ...EXITED, code: null, timedOut: 'stall' });
    return Promise.resolve({ ...EXITED, ...ended });
  },
});

const hooksOf = (signal = new AbortController().signal) => ({ started: () => undefined, signal });
const LAUNCH = { command: 'stand-in', args: ['--json'], cwd: '.', input: 'brief', stallMs: 1_000, wallMs: 60_000 };

test('a stream that goes silent past stallMs ends timed-out', async () => {
  const runner = launcher({ lines: [SAID], silentMs: 5_000 });
  const ended = await cliCall.run(runner, hooksOf(), { launch: LAUNCH, read: readStandIn });
  assert.equal(ended.status, 'timed-out');
  // A stop is no failure of the stream's, though it ended with no done line.
  assert.equal(ended.failure, null);
  assert.deepEqual(ended.stream.lines, [SAID]);
});

test('a cancel ends killed', async () => {
  const cancel = new AbortController();
  cancel.abort();
  const ended = await cliCall.run(launcher({ lines: [SAID] }), hooksOf(cancel.signal), {
    launch: LAUNCH,
    read: readStandIn,
  });
  assert.equal(ended.status, 'killed');
  assert.equal(ended.failure, null);
});

test('a nonzero exit puts the stderr tail in the failure message', async () => {
  const runner = launcher({ lines: [SAID], ended: { code: 2, stderrTail: '  at stand-in: out of memory\n' } });
  const ended = await cliCall.run(runner, hooksOf(), { launch: LAUNCH, read: readStandIn });
  assert.equal(ended.status, 'failed');
  assert.deepEqual(ended.failure, {
    failureClass: 'unknown',
    message: 'the stand-in stream ended with no done line\nstderr:   at stand-in: out of memory',
  });
  assert.equal(ended.ended?.code, 2);
});

test("the stall clock's idle check answers the Harness's last activity from the lines so far", async () => {
  const asked: (number | null)[] = [];
  const runner: Runner = {
    launch: async (options) => {
      options.onLine?.(SAID);
      asked.push(await options.onIdle!());
      return EXITED;
    },
  };
  await cliCall.run(runner, hooksOf(), { launch: LAUNCH, read: readStandIn, lastActivity: (lines) => lines.length });
  assert.deepEqual(asked, [1]);
});

test('a launch that cannot start is an unknown failure, never a throw', async () => {
  const runner: Runner = { launch: () => Promise.reject(new Error('spawn stand-in ENOENT')) };
  const ended = await cliCall.run(runner, hooksOf(), { launch: LAUNCH, read: readStandIn });
  assert.deepEqual(
    { status: ended.status, failure: ended.failure, ended: ended.ended },
    { status: 'failed', failure: { failureClass: 'unknown', message: 'spawn stand-in ENOENT' }, ended: null },
  );
});
