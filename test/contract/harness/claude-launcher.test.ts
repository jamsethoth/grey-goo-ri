// Launcher acceptance through the Claude Harness (request section 5): each behaviour asked of a launch, shown through
// harness.run over the fake claude CLI, on Windows and Ubuntu, with a space in every path the call carries (#426).
// lib/exec.ts's own launch cases (test/contract/exec/launch.test.ts) stay, and do not count for this.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import * as claudeOverFakeCli from '../../support/claude-over-fake-cli.ts';
import * as processProbe from '../../support/process-probe.ts';

const { claudeCall, hooksOf } = claudeOverFakeCli;
const fakeCli = claudeOverFakeCli.claudeOverFakeCli;
const CASE = { timeout: 120_000 };

// A stop's clock: long enough that the fake has started its descendant before the stop, so the case can see the
// descendant go.
const STOP_MS = 3_000;

// What the Harness's stderr text is, written by the fake to its stderr.
const STDERR = 'claude: the CLI said this on stderr';

// One way a call ends: the fake's recording and mode, the call's changes, and whether its signal aborts once the fake
// has started its descendant.
interface Ending {
  cli: claudeOverFakeCli.FakeCli;
  changes: Record<string, unknown>;
  cancels: boolean;
}

const ENDINGS: Record<string, Ending> = {
  'a clean exit': { cli: { scenario: 'success' }, changes: {}, cancels: false },
  'a failed exit': { cli: { scenario: 'auth-failure' }, changes: {}, cancels: false },
  'a stall': {
    cli: { scenario: 'success', mode: 'hang' },
    changes: { timeouts: { stallMs: STOP_MS } },
    cancels: false,
  },
  'the wall clock': {
    cli: { scenario: 'success', mode: 'hang' },
    changes: { timeouts: { wallMs: STOP_MS } },
    cancels: false,
  },
  'a cancel': { cli: { scenario: 'success', mode: 'hang' }, changes: {}, cancels: true },
};

// Runs a call that ends this way over a fake that leaves an orphan descendant, and reads its tree once it resolves:
// the CLI's process and the descendant, each started and no longer running.
async function endedTree(t: TestContext, { cli, changes, cancels }: Ending) {
  const fake = fakeCli(t, { ...cli, orphan: true });
  const controller = new AbortController();
  const started = () => {
    if (cancels) {
      void processProbe
        .waitFor(() => processProbe.pidIn(fake.orphanPidFile) > 0, t.signal)
        .then(() => controller.abort());
    }
  };
  const { result } = await fake.harness.run(claudeCall(fake, changes), hooksOf({ started, signal: controller.signal }));
  const [cliPid, descendant] = [fake.cliPidFile, fake.orphanPidFile].map((pidFile) => processProbe.pidIn(pidFile));
  return {
    status: result.status,
    cliStarted: Boolean(cliPid),
    cliAlive: Boolean(cliPid) && processProbe.alive(cliPid ?? 0),
    descendantStarted: Boolean(descendant),
    descendantAlive: Boolean(descendant) && processProbe.alive(descendant ?? 0),
    confirmed: result.cleanup?.confirmed,
  };
}

const goneTree = (status: string) => ({
  status,
  cliStarted: true,
  cliAlive: false,
  descendantStarted: true,
  descendantAlive: false,
  confirmed: true,
});

test('the Claude Harness sends the prompt on stdin, never argv', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  await fake.harness.run(claudeCall(fake, { brief: 'the prompt, on stdin' }), hooksOf());
  const { argv, stdin } = fake.received();
  assert.deepEqual(
    { stdin, inArgv: argv.filter((argument) => argument.includes('the prompt')) },
    { stdin: 'the prompt, on stdin', inArgv: [] },
  );
});

// Every path the launch carries, read from what launch was given: the repository, the Run directory and the files
// launchArgs names in it, the Claude configuration directory, and the fake's own script and recording.
test('every path a Claude call carries holds a space', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success' });
  await fake.harness.run(claudeCall(fake), hooksOf());
  const [options] = fake.launches;
  const values = [options?.cwd, ...(options?.args ?? []), ...Object.values(options?.env ?? {})];
  const paths = values.filter((value): value is string => typeof value === 'string' && isAbsolute(value));
  assert.ok(paths.length >= 5, `the paths: ${JSON.stringify(paths)}`);
  assert.deepEqual(
    paths.filter((path) => !path.includes(' ')),
    [],
  );
});

test('a call silent past its stall timeout is timed-out and its tree is gone', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['a stall'] as Ending), goneTree('timed-out'));
});

test('a call past its wall clock is timed-out and its tree is gone', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['the wall clock'] as Ending), goneTree('timed-out'));
});

test('a cancelled call is killed and its tree is gone', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['a cancel'] as Ending), goneTree('killed'));
});

// Every way a call ends, at once: a descendant the CLI left behind is gone by the time the Harness resolves.
test('descendants the CLI orphaned are killed', CASE, async (t) => {
  const names = Object.keys(ENDINGS);
  const trees = await Promise.all(names.map((name) => endedTree(t, ENDINGS[name] as Ending)));
  const left = names.flatMap((name, index) => {
    const tree = trees[index];
    return tree?.descendantStarted && !tree.descendantAlive ? [] : [`${name}: ${JSON.stringify(tree)}`];
  });
  assert.deepEqual(left, []);
});

// Q1 A: a failed call's stderr tail joins its failure message, which the Execution Record saves.
test('a failed call keeps its stderr tail and the init event in its result', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'auth-failure', stderr: STDERR });
  const { result, failure } = await fake.harness.run(claudeCall(fake), hooksOf());
  const message = failure?.message ?? '';
  assert.deepEqual(
    {
      status: result.status,
      streamMessage: message.includes('Invalid API key'),
      stderrTail: message.includes(STDERR),
      sessionInit: result.sessionInit != null,
    },
    { status: 'failed', streamMessage: true, stderrTail: true, sessionInit: true },
  );
});

// A Windows process has no signal to report, so the signal half runs on POSIX only, as launch's own case does.
test('the exit code and the signal are recorded', CASE, async (t) => {
  const exited = fakeCli(t, { scenario: 'auth-failure' });
  const { result } = await exited.harness.run(claudeCall(exited), hooksOf());
  const recorded: Record<string, unknown> = { exit: { exitCode: result.exitCode, exitSignal: result.exitSignal } };
  const expected: Record<string, unknown> = { exit: { exitCode: 1, exitSignal: null } };
  if (process.platform !== 'win32') {
    const signalled = fakeCli(t, { scenario: 'success', mode: 'signal' });
    const ended = (await signalled.harness.run(claudeCall(signalled), hooksOf())).result;
    recorded.signal = { exitCode: ended.exitCode, exitSignal: ended.exitSignal };
    expected.signal = { exitCode: null, exitSignal: 'SIGTERM' };
  }
  assert.deepEqual(recorded, expected);
});
