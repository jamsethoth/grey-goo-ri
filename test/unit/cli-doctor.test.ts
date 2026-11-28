// What every Harness's doctor does with its Agent CLI (#480): a command started and said, its version and its login
// checked, a probe's temporary directory; over a launch double for a stand-in CLI that is neither Claude nor Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as cliDoctor from '../../lib/harnesses/cli-doctor.ts';
import * as storeAlias from '../support/store-alias.ts';

// The launch the module is handed, as a small test may name it without importing lib/exec.ts.
type Runner = Parameters<typeof cliDoctor.said>[0];
type LaunchResult = Awaited<ReturnType<Runner['launch']>>;

const CLEANUP = { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' as const } };
const EXITED: LaunchResult = {
  code: 0,
  signal: null,
  timedOut: null,
  cancelled: false,
  stderrTail: '',
  cleanup: CLEANUP,
};

// A launch double: the stand-in CLI prints `lines` and runs for `runsMs`, which the wall clock stops when it is past
// wallMs, then ends as `ended` says.
const printing = ({
  lines = [],
  runsMs = 0,
  ended = {},
}: {
  lines?: string[];
  runsMs?: number;
  ended?: Partial<LaunchResult>;
}): Runner => ({
  launch: (options) => {
    for (const line of lines) options.onLine?.(line);
    if (options.wallMs !== undefined && runsMs > options.wallMs)
      return Promise.resolve({ ...EXITED, code: null, timedOut: 'wall' });
    return Promise.resolve({ ...EXITED, ...ended });
  },
});

const STAND_IN = { command: 'stand-in', minimum: '2.1.10', update: 'stand-in upgrade' };

test('a version below the pinned minimum fails, naming the minimum and how to update', async () => {
  const ran = await cliDoctor.said(printing({ lines: ['2.1.9 (stand-in)'] }), {
    command: 'stand-in',
    args: ['--version'],
  });
  assert.deepEqual(cliDoctor.versionCheck(ran, STAND_IN), {
    name: 'version',
    ok: false,
    severity: 'error',
    message: 'stand-in 2.1.9 is older than the minimum 2.1.10: update it with stand-in upgrade',
  });
});

test('a version at or past the pinned minimum passes, naming it', async () => {
  const ran = await cliDoctor.said(printing({ lines: ['2.1.10 (stand-in)'] }), {
    command: 'stand-in',
    args: ['--version'],
  });
  assert.deepEqual(cliDoctor.versionCheck(ran, STAND_IN), {
    name: 'version',
    ok: true,
    severity: 'error',
    message: 'stand-in 2.1.10',
  });
});

test('a first line that does not start with a version fails, saying what it printed', async () => {
  const ran = await cliDoctor.said(printing({ lines: ['stand-in 9.0.0'] }), {
    command: 'stand-in',
    args: ['--version'],
  });
  assert.deepEqual(cliDoctor.versionCheck(ran, STAND_IN), {
    name: 'version',
    ok: false,
    severity: 'error',
    message: 'stand-in --version printed "stand-in 9.0.0"',
  });
});

test('each part of a version compares as a number, so 2.10.0 meets the minimum 2.9.1', () => {
  assert.equal(cliDoctor.atLeastMinimum('2.10.0', '2.9.1'), true);
  assert.equal(cliDoctor.atLeastMinimum('2.9.0', '2.9.1'), false);
});

test('a command running past the cheap wall limit is said timed out', async () => {
  const ran = await cliDoctor.said(printing({ runsMs: 61_000 }), { command: 'stand-in', args: ['--version'] });
  assert.deepEqual(ran, { started: true, lines: [], failure: 'stand-in --version timed out', exited: null });
  assert.equal(cliDoctor.reasonOf(ran), 'stand-in --version timed out');
});

test('a command that cannot start is said not started, with why', async () => {
  const runner = { launch: () => Promise.reject(new Error('spawn stand-in ENOENT')) };
  const ran = await cliDoctor.said(runner, { command: 'stand-in', args: ['--version'] });
  assert.deepEqual(ran, { started: false, lines: [], failure: 'spawn stand-in ENOENT', exited: null });
});

test('an error exit is said with its code, under the name the command is given', async () => {
  const runner = printing({ lines: ['{"event":"said"}'], ended: { code: 3 } });
  const ran = await cliDoctor.said(runner, {
    command: 'stand-in',
    args: ['exec', '--json', '--model', 'small'],
    name: 'stand-in exec',
  });
  assert.deepEqual(ran, {
    started: true,
    lines: ['{"event":"said"}'],
    failure: null,
    exited: 'stand-in exec exited 3',
  });
});

test('a command a signal ends is said ended by it', async () => {
  const ran = await cliDoctor.said(printing({ ended: { code: null, signal: 'SIGKILL' } }), {
    command: 'stand-in',
    args: ['whoami'],
  });
  assert.equal(ran.exited, 'stand-in whoami ended by SIGKILL');
});

test('a CLI that is not logged in fails with the command that logs it in', async () => {
  const ran = await cliDoctor.said(printing({ lines: ['signed out'] }), { command: 'stand-in', args: ['whoami'] });
  const status = {
    command: 'stand-in',
    loggedIn: false,
    unreadable: 'stand-in whoami printed nothing',
    login: 'stand-in login',
  };
  assert.deepEqual(cliDoctor.loginCheck(ran, status), {
    name: 'login',
    ok: false,
    severity: 'error',
    message: 'stand-in is not logged in: log in with stand-in login',
  });
});

test('a login status the Harness cannot read fails with what the command printed and why it failed', async () => {
  const ran = await cliDoctor.said(printing({ ended: { code: 1 } }), { command: 'stand-in', args: ['whoami'] });
  const status = {
    command: 'stand-in',
    loggedIn: null,
    unreadable: 'stand-in whoami printed nothing',
    login: 'stand-in login',
  };
  assert.deepEqual(cliDoctor.loginCheck(ran, status), {
    name: 'login',
    ok: false,
    severity: 'error',
    message: 'stand-in whoami printed nothing: stand-in whoami exited 1',
  });
});

test("only a stream's lines that are JSON objects are read", () => {
  const lines = ['{"event":"init","model":"small"}', 'a plain line', '[1,2]', '"text"', '{"event":"done"}'];
  assert.deepEqual(cliDoctor.objectLines(lines), [{ event: 'init', model: 'small' }, { event: 'done' }]);
});

test("a probe's temporary directory is there for its use and gone after it", async () => {
  const seen = await cliDoctor.inTemporary('gg-stand-in-probe-', (directory) =>
    Promise.resolve({ directory, during: existsSync(directory) }),
  );
  assert.deepEqual({ during: seen.during, after: existsSync(seen.directory) }, { during: true, after: false });
});

// ADR 0030 decision 2: the Store's pwsh on PATH is an app execution alias, a link whose target existsSync cannot stat,
// so the shell is found by the link and judged packaged by where it leads (#533).
test('the shell a link on PATH starts is found, and judged packaged by its target under WindowsApps', (t) => {
  const bin = storeAlias.storeAlias(t);
  assert.deepEqual(cliDoctor.findShell('pwsh.exe', bin), { path: join(bin, 'pwsh.exe'), packaged: true });
});

// A PATH entry whose lstat fails for a reason other than a missing file (an unreachable share, a name too long) is
// skipped, as existsSync skipped it, so the doctor still finds the shell after it (#533 QA).
test('a PATH entry that cannot be read is skipped, and the shell after it is found', (t) => {
  const bin = storeAlias.storeAlias(t);
  const tooLong = join(tmpdir(), ...Array<string>(200).fill('y'.repeat(200)));
  assert.deepEqual(cliDoctor.findShell('pwsh.exe', [tooLong, bin].join(delimiter)), {
    path: join(bin, 'pwsh.exe'),
    packaged: true,
  });
});

// #497 Q1 A: the profile probe's first request is the floor a fresh Session starts at, and a budget below twice it
// leaves a real Attempt, which starts higher, little or no room before its first hand-off.
test('a measured starting context passes, naming the tokens a fresh Session starts at', () => {
  const checks = cliDoctor.startChecks(9755, {});
  assert.equal(checks.length, 1, JSON.stringify(checks));
  const [start] = checks;
  assert.deepEqual({ name: start!.name, ok: start!.ok }, { name: 'starting-context', ok: true });
  assert.ok(start!.message.includes('9755'), start!.message);
});

test('a contextBudget below twice the start warns, naming the Agent, its budget, the start and the threshold', () => {
  const warnings = cliDoctor.startChecks(9000, { tight: { contextBudget: 8000 } }).filter(({ ok }) => !ok);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const [warning] = warnings;
  assert.deepEqual(
    { name: warning!.name, severity: warning!.severity },
    { name: 'context-budget', severity: 'warning' },
  );
  for (const said of ['agent tight', '8000', '9000', '18000'])
    assert.ok(warning!.message.includes(said), `the warning names ${said}: ${warning!.message}`);
});

test('a contextBudget one token below twice the start warns, and one at twice it does not', () => {
  const agents = {
    under: { contextBudget: 17_999 },
    twice: { contextBudget: 18_000 },
    over: { contextBudget: 18_001 },
  };
  const warned = cliDoctor
    .startChecks(9000, agents)
    .filter(({ ok }) => !ok)
    .map(({ message }) => message);
  assert.equal(warned.length, 1, JSON.stringify(warned));
  assert.ok(warned[0]!.includes('agent under'), warned[0]);
});

test('an Agent with no contextBudget is no warning', () => {
  const checks = cliDoctor.startChecks(9000, { unbudgeted: { model: 'small' }, declaredOddly: 'not an object' });
  assert.deepEqual(
    checks.map(({ name, ok }) => ({ name, ok })),
    [{ name: 'starting-context', ok: true }],
  );
});

test('a probe that measured no start warns that no contextBudget was checked, and judges no Agent', () => {
  const checks = cliDoctor.startChecks(null, { tight: { contextBudget: 1 } });
  assert.deepEqual(
    checks.map(({ name, ok, severity }) => ({ name, ok, severity })),
    [{ name: 'starting-context', ok: false, severity: 'warning' }],
  );
  assert.ok(checks[0]!.message.includes('contextBudget'), checks[0]!.message);
});
