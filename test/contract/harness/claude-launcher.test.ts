// Launcher acceptance through the Claude Harness (request section 5): each behaviour asked of a launch, shown through
// harness.run over the fake claude CLI, on Windows and Ubuntu, with a space in every path the call carries (#426).
// lib/exec.ts's own launch cases (test/contract/exec/launch.test.ts) stay, and do not count for this.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as claudeOverFakeCli from '../../support/claude-over-fake-cli.ts';
import * as processProbe from '../../support/process-probe.ts';

const { claudeCall, hooksOf } = claudeOverFakeCli;
const fakeCli = claudeOverFakeCli.claudeOverFakeCli;
const CASE = { timeout: 120_000 };

// A stop's clock. The fixture holds the stall and wall clocks until the fake's descendant has written its pid, so the
// stop always comes after the descendant and the case can see it go, however slowly the machine starts it (#475).
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
    // The case's own end cancels too, so a case that times out before the pid comes still ends the call's tree.
    if (cancels) {
      const abort = () => controller.abort();
      void processProbe.waitFor(() => processProbe.pidIn(fake.orphanPidFile) > 0, t.signal).then(abort, abort);
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

// Every path the call carries, by its role: the repository, the settings and persona files launchArgs names in the
// Run directory, a listed plugin's directory and the Claude configuration directory, each as the Harness gave launch;
// the fake's own script, recording, received and pid files, each shown reached by what the fake did with it. The
// fixture checks every absolute path in each launch's working directory, argv and environment holds a space.
test('every path a Claude call carries holds a space', CASE, async (t) => {
  const fake = fakeCli(t, { scenario: 'success', orphan: true });
  const plugin = join(fake.configDirectory, 'plugins', 'a plugin');
  mkdirSync(plugin, { recursive: true });
  const installed = { plugins: { 'alpha@mkt': [{ installPath: plugin }] } };
  writeFileSync(join(fake.configDirectory, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  const agent = { harness: 'claude', persona: 'implementer.md', access: 'workspace-write', plugins: ['alpha'] };
  const tools = fake.harness.resolveTools(agent, { commands: {}, platform: process.platform });
  const { result } = await fake.harness.run(claudeCall(fake, { agent, tools }), hooksOf());
  const { cwd = '', args = [] } = fake.launches[0] ?? {};
  const after = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
  assert.deepEqual(
    {
      repository: cwd.includes(' '),
      settings: after('--settings').includes(' '),
      persona: after('--append-system-prompt-file').includes(' '),
      plugin: after('--plugin-dir') === plugin && plugin.includes(' '),
      configDirectory: fake.configDirectory.includes(' '),
      scriptAndRecording: result.status,
      received: fake.received().stdin !== null,
      cliPid: processProbe.pidIn(fake.cliPidFile) > 0,
      orphanPid: processProbe.pidIn(fake.orphanPidFile) > 0,
    },
    {
      repository: true,
      settings: true,
      persona: true,
      plugin: true,
      configDirectory: true,
      scriptAndRecording: 'completed',
      received: true,
      cliPid: true,
      orphanPid: true,
    },
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
      stderrTail: message.endsWith(`\nstderr: ${STDERR}`),
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
