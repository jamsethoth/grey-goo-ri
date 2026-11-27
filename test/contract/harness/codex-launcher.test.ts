// Launcher acceptance through the Codex Harness (request section 5): each behaviour asked of a launch, shown through
// harness.run over the fake codex CLI, on Windows and Ubuntu, with a space in every path the call carries (#483), as
// claude-launcher.test.ts shows it for Claude. Under Codex an agent's commands run under MXC's sandbox helper, which
// #479 found holds in gg's job with each process it starts (ADR 0030 decision 6), so the fake leaves its descendant the
// way MXC would: a helper re-run of the CLI that stays while the command it started runs (#483 Q1 A).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as codexOverFakeCli from '../../support/codex-over-fake-cli.ts';
import * as processProbe from '../../support/process-probe.ts';

const { codexCall, hooksOf } = codexOverFakeCli;
const fakeCli = codexOverFakeCli.codexOverFakeCli;
const CASE = { timeout: 120_000 };
const TABLE = { timeout: 300_000 };

// A stop's clock. The fixture holds the stall and wall clocks until the fake's descendant has written its pid, so the
// stop always comes after the descendant and the case can see it go, however slowly the machine starts it (#475).
const STOP_MS = 3_000;

// What the Harness's stderr text is, written by the fake to its stderr.
const STDERR = 'codex: the CLI said this on stderr';

// The thread the auth-invalid recording opened before its turn failed.
const AUTH_INVALID_THREAD = '01a20440-50c8-7923-b3a5-793457baeead';

// What a call's tree is held in: gg's job on Windows, a process group elsewhere, which the Harness's started hook
// reports as none.
const WINDOWS = process.platform === 'win32';
const CONTAINMENT = WINDOWS ? 'job' : 'group';
const REPORTS = WINDOWS ? ['job'] : ['none'];

// One way a call ends: the fake's recording and mode, the call's changes, and whether its signal aborts once the fake
// has started its descendant.
interface Ending {
  cli: codexOverFakeCli.FakeCodex;
  changes: Record<string, unknown>;
  cancels: boolean;
}

const ENDINGS: Record<string, Ending> = {
  'a clean exit': { cli: { scenario: 'start' }, changes: {}, cancels: false },
  'a failed exit': { cli: { scenario: 'auth-invalid' }, changes: {}, cancels: false },
  'a stall': {
    cli: { scenario: 'start', mode: 'hang' },
    changes: { timeouts: { stallMs: STOP_MS } },
    cancels: false,
  },
  'the wall clock': {
    cli: { scenario: 'start', mode: 'hang' },
    changes: { timeouts: { wallMs: STOP_MS } },
    cancels: false,
  },
  'a cancel': { cli: { scenario: 'start', mode: 'hang' }, changes: {}, cancels: true },
};

// Runs a call that ends this way over a fake that leaves an MXC-shaped descendant, and reads its tree once it
// resolves: the CLI's process, the sandbox helper and the command under it, each started and no longer running, the
// cleanup confirmed over the containment the call ran in, and each containment the Harness's started hook was told.
async function endedTree(t: TestContext, { cli, changes, cancels }: Ending) {
  const fake = fakeCli(t, { ...cli, orphan: true });
  const controller = new AbortController();
  const reports: string[] = [];
  const started = ({ kind }: { kind: string }) => {
    reports.push(kind);
    // The case's own end cancels too, so a case that times out before the pid comes still ends the call's tree.
    if (cancels) {
      const abort = () => controller.abort();
      void processProbe.waitFor(() => processProbe.pidIn(fake.orphanPidFile) > 0, t.signal).then(abort, abort);
    }
  };
  const { result } = await fake.harness.run(codexCall(fake, changes), hooksOf({ started, signal: controller.signal }));
  const [cliPid, helper, descendant] = [fake.cliPidFile, fake.helperPidFile, fake.orphanPidFile].map((pidFile) =>
    processProbe.pidIn(pidFile),
  );
  return {
    status: result.status,
    cliStarted: Boolean(cliPid),
    cliAlive: Boolean(cliPid) && processProbe.alive(cliPid ?? 0),
    helperStarted: Boolean(helper),
    helperAlive: Boolean(helper) && processProbe.alive(helper ?? 0),
    descendantStarted: Boolean(descendant),
    descendantAlive: Boolean(descendant) && processProbe.alive(descendant ?? 0),
    confirmed: result.cleanup?.confirmed,
    containment: result.cleanup?.containment?.kind,
    reports,
  };
}

const goneTree = (status: string) => ({
  status,
  cliStarted: true,
  cliAlive: false,
  helperStarted: true,
  helperAlive: false,
  descendantStarted: true,
  descendantAlive: false,
  confirmed: true,
  containment: CONTAINMENT,
  reports: REPORTS,
});

test('the prompt arrives on stdin', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'start' });
  await fake.harness.run(codexCall(fake, { brief: 'the prompt, on stdin' }), hooksOf());
  const { argv, stdin } = fake.received();
  assert.deepEqual(
    {
      onStdin: stdin?.includes('the prompt, on stdin'),
      inArgv: argv.filter((argument) => argument.includes('the prompt')),
    },
    { onStdin: true, inArgv: [] },
  );
});

test('a call silent past stallMs is timed-out', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['a stall'] as Ending), goneTree('timed-out'));
});

test('a call past wallMs is timed-out', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['the wall clock'] as Ending), goneTree('timed-out'));
});

test('a cancel ends killed', CASE, async (t) => {
  assert.deepEqual(await endedTree(t, ENDINGS['a cancel'] as Ending), goneTree('killed'));
});

// Every way a call ends, at once: the sandbox helper and the command it started are gone by the time the Harness
// resolves, held in gg's job on Windows, with the cleanup confirmed (ADR 0030 decision 6).
test('a descendant left running is killed with the tree', TABLE, async (t) => {
  const names = Object.keys(ENDINGS);
  const trees = await Promise.all(names.map((name) => endedTree(t, ENDINGS[name] as Ending)));
  const left = names.flatMap((name, index) => {
    const tree = trees[index];
    const gone = tree?.helperStarted && !tree.helperAlive && tree.descendantStarted && !tree.descendantAlive;
    const held = tree?.confirmed === true && tree.containment === CONTAINMENT;
    return gone && held && JSON.stringify(tree.reports) === JSON.stringify(REPORTS)
      ? []
      : [`${name}: ${JSON.stringify(tree)}`];
  });
  assert.deepEqual(left, []);
});

// Codex 0.171 keeps no call log (#482 Q3 A): a failed call's stderr tail joins the stream's error in its failure
// message, which the Execution Record saves, and its thread's rollout, the session's own log, is kept.
test('stderr and the log tail are kept on failure', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'auth-invalid', stderr: STDERR });
  const { result, failure } = await fake.harness.run(codexCall(fake), hooksOf());
  const message = failure?.message ?? '';
  assert.deepEqual(
    {
      status: result.status,
      streamMessage: message.startsWith('unexpected status 401 Unauthorized'),
      stderrTail: message.endsWith(`\nstderr: ${STDERR}`),
      sessionId: result.sessionId,
      rollout: result.transcriptPath !== null && existsSync(result.transcriptPath),
    },
    { status: 'failed', streamMessage: true, stderrTail: true, sessionId: AUTH_INVALID_THREAD, rollout: true },
  );
});

// A Windows process has no signal to report, so the signal half runs on POSIX only, as launch's own case does.
test('the exit code and signal are recorded', CASE, async (t) => {
  const exited = fakeCli(t, { scenario: 'auth-invalid' });
  const { result } = await exited.harness.run(codexCall(exited), hooksOf());
  const recorded: Record<string, unknown> = { exit: { exitCode: result.exitCode, exitSignal: result.exitSignal } };
  const expected: Record<string, unknown> = { exit: { exitCode: 1, exitSignal: null } };
  if (!WINDOWS) {
    const signalled = fakeCli(t, { scenario: 'start', mode: 'signal' });
    const ended = (await signalled.harness.run(codexCall(signalled), hooksOf())).result;
    recorded.signal = { exitCode: ended.exitCode, exitSignal: ended.exitSignal };
    expected.signal = { exitCode: null, exitSignal: 'SIGTERM' };
  }
  assert.deepEqual(recorded, expected);
});
