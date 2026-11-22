// lib/exec.ts's launch on every platform: an argv run contained, with no shell, under its stall and wall clocks and the
// cancel signal, its whole tree taken down when it stops (#423). The .cmd shim cases are Windows', where shims exist.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exec from '../../../lib/exec.ts';
import * as caseEnv from '../../support/case-env.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-launch-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { CASE, WIN_CASE, UNSANDBOXED_CASE } = options;
const { launch } = exec.createExec();
const SHIM = fileURLToPath(new URL('../../fixtures/cmd-shim/argv-printer.cmd', import.meta.url));

// A process that prints its arguments, one JSON line.
const PRINT_ARGS = ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'];

test('launch passes its input on stdin and closes it', CASE, async () => {
  const lines: string[] = [];
  const result = await launch({
    command: process.execPath,
    args: ['-e', "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => console.log('read ' + s))"],
    input: 'the brief',
    wallMs: 60_000,
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(
    { code: result.code, timedOut: result.timedOut, lines },
    {
      code: 0,
      timedOut: null,
      lines: ['read the brief'],
    },
  );
});

test('launch runs an argv with spaces and quotes unchanged, with no shell', CASE, async () => {
  const lines: string[] = [];
  const args = ['two words', 'say "hi"', 'a\\"b', 'C:\\a dir\\', '', '%PATH%', '$HOME', 'a^b', 'x & y', '|', "it's"];
  const result = await launch({
    command: process.execPath,
    args: [...PRINT_ARGS, ...args],
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(
    { code: result.code, argv: lines.map((line) => JSON.parse(line) as unknown) },
    {
      code: 0,
      argv: [['two words', 'say "hi"', 'a\\"b', 'C:\\a dir\\', '', '%PATH%', '$HOME', 'a^b', 'x & y', '|', "it's"]],
    },
  );
});

// What a clock's stop left: the process whose pid is in pidFile is checked by its own pid, so a launcher that left it
// running fails here and not only in a census, which Ubuntu does not run; a stop before it wrote its pid shows as not
// started (#475).
const stopOf = (result: exec.LaunchResult, pidFile: string) => {
  const pid = processProbe.pidIn(pidFile);
  return {
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    started: pid > 0,
    alive: pid > 0 && processProbe.alive(pid),
    confirmed: result.cleanup.confirmed,
  };
};
// A stop that took down the process it checks, once that process had started.
const GONE = { started: true, alive: false, confirmed: true };

// onIdle answers only once the child has written its pid, so the stall stops a process the case can check.
test('launch stops a process silent past stallMs and says stall', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'stall.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile],
    stallMs: 500,
    onIdle: async () => (await processProbe.waitFor(() => processProbe.pidIn(pidFile) > 0, t.signal), null),
  });
  assert.deepEqual(stopOf(result, pidFile), { timedOut: 'stall', cancelled: false, ...GONE });
});

// A transcript whose stat fails makes the Claude Harness's onIdle throw: that is no activity, a typed stall, never an
// unhandled rejection that ends gg (#425 D11 A).
test('an onIdle that throws counts as no activity, and the stall stops the process', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'idle-throws.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile],
    stallMs: 500,
    onIdle: async () => {
      await processProbe.waitFor(() => processProbe.pidIn(pidFile) > 0, t.signal);
      throw Object.assign(new Error('EPERM: operation not permitted, stat'), { code: 'EPERM' });
    },
  });
  assert.deepEqual(stopOf(result, pidFile), { timedOut: 'stall', cancelled: false, ...GONE });
});

// 60 lines 100 ms apart take at least 5.9 s, past stallMs, while no gap between them, nor the start of node behind the
// Windows gate, comes near it.
test('output resets the stall clock', CASE, async () => {
  const lines: string[] = [];
  const result = await launch({
    command: process.execPath,
    args: [
      '-e',
      "let n = 0; const t = setInterval(() => { console.log('tick'); if (++n === 60) clearInterval(t); }, 100)",
    ],
    stallMs: 5000,
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(
    { code: result.code, timedOut: result.timedOut, lines: lines.length },
    {
      code: 0,
      timedOut: null,
      lines: 60,
    },
  );
});

test('stderr output resets the stall clock too', CASE, async () => {
  const lines: string[] = [];
  const result = await launch({
    command: process.execPath,
    args: [
      '-e',
      "let n = 0; const t = setInterval(() => { console.error('tick'); if (++n === 60) clearInterval(t); }, 100)",
    ],
    stallMs: 5000,
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, lines }, { code: 0, timedOut: null, lines: [] });
});

// Asked at the first stall, onIdle says the last activity was 2800 ms before it, so the clock re-arms for the 200 ms
// left of stallMs and stops the process near 3200 ms, 2.3 s before the wall clock. A full stallMs from the ask, near
// 6000 ms, would reach the wall clock first.
test("onIdle's last activity re-arms the stall clock for what is left of stallMs", UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'idle.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const asked: number[] = [];
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile],
    stallMs: 3000,
    wallMs: 5500,
    onIdle: () => {
      asked.push(Date.now());
      return (asked[0] ?? 0) - 2800;
    },
  });
  assert.deepEqual(
    { timedOut: result.timedOut, askedAgain: asked.length >= 2 },
    { timedOut: 'stall', askedAgain: true },
  );
});

// The child prints b 2.5 s after a, while onIdle, asked at the 2 s stall, waits to see b before it answers; the child
// exits 0.3 s after b, well inside the 2 s that b re-arms.
test('output that arrives while onIdle is pending re-arms the stall clock', CASE, async () => {
  let sawB = () => {};
  const seenB = new Promise<void>((resolve) => (sawB = resolve));
  // b reaching gg before the stall check asks onIdle would pass without testing the rule, so the case records it
  let idlePending = false;
  let bWhilePending = false;
  const result = await launch({
    command: process.execPath,
    args: [
      '-e',
      "console.log('a'); setTimeout(() => { console.log('b'); setTimeout(() => process.exit(0), 300); }, 2500);",
    ],
    stallMs: 2000,
    onLine: (line) => line === 'b' && ((bWhilePending = idlePending), sawB()),
    onIdle: async () => {
      idlePending = true;
      await seenB;
      return null;
    },
  });
  assert.deepEqual(
    { code: result.code, timedOut: result.timedOut, bWhilePending },
    { code: 0, timedOut: null, bWhilePending: true },
  );
});

// The wall clock counts from when the child has written its pid, so the stop comes after the process the case checks.
test('launch stops a process past wallMs and says wall', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'wall.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile],
    stallMs: 60_000,
    wallMs: 150,
    testHooks: { signal: processProbe.pidWritten(pidFile, t.signal) },
  });
  assert.deepEqual(stopOf(result, pidFile), { timedOut: 'wall', cancelled: false, ...GONE });
});

// setTimeout fires after 1 ms past 2147483647 ms (24.8 days), so the launch clock caps both limits there (#429 D3 A).
const PAST_TIMER_CAP = 2_147_483_648;
const SHORT_RUN = ['-e', "setTimeout(() => console.log('done'), 500)"];

test('a wallMs past the timer cap does not stop the process at once', CASE, async () => {
  const lines: string[] = [];
  const result = await launch({
    command: process.execPath,
    args: SHORT_RUN,
    wallMs: PAST_TIMER_CAP,
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(
    { code: result.code, timedOut: result.timedOut, lines },
    { code: 0, timedOut: null, lines: ['done'] },
  );
});

test('a stallMs past the timer cap arms its clock with no overflow warning', CASE, async (t) => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.name);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const result = await launch({ command: process.execPath, args: SHORT_RUN, stallMs: PAST_TIMER_CAP });
  assert.deepEqual(
    {
      code: result.code,
      timedOut: result.timedOut,
      overflows: warnings.filter((name) => name === 'TimeoutOverflowWarning'),
    },
    { code: 0, timedOut: null, overflows: [] },
  );
});

test('an aborted signal stops the process and says cancelled', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'cancel.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const controller = new AbortController();
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile, 'started'],
    signal: controller.signal,
    // The child prints before it writes its pid, so the abort waits for the pid the case checks; the case's own end
    // aborts too, so a case that times out still ends its child.
    onLine: () => {
      const abort = () => controller.abort();
      void processProbe.waitFor(() => processProbe.pidIn(pidFile) > 0, t.signal).then(abort, abort);
    },
  });
  assert.deepEqual(stopOf(result, pidFile), { timedOut: null, cancelled: true, ...GONE });
});

// The grandchild starts before its parent prints, so a launcher that contained the process only once it spoke would
// miss it; the parent's line cancels the launch.
test('a grandchild started before the first output line is killed with its tree', UNSANDBOXED_CASE, async (t) => {
  // Ends the parent too: a launcher that skipped the take-down would leave it holding the test file open.
  const pidFile = join(scratch, 'grandchild.pid');
  t.after(() => [pidFile, `${pidFile}.parent`].forEach((file) => processProbe.endProcessIn(file)));
  const controller = new AbortController();
  const result = await launch({
    command: process.execPath,
    args: [childScripts.GRANDCHILD_FIRST, pidFile, 'ready'],
    signal: controller.signal,
    onLine: () => controller.abort(),
  });
  const grandchild = processProbe.pidIn(pidFile);
  assert.deepEqual(
    {
      started: grandchild > 0,
      alive: grandchild > 0 && processProbe.alive(grandchild),
      confirmed: result.cleanup.confirmed,
    },
    { started: true, alive: false, confirmed: true },
  );
});

test('launch reports the exit code and the signal', CASE, async () => {
  const result = await launch({ command: process.execPath, args: ['-e', 'process.exit(7)'] });
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 7, signal: null });
});

test(
  'launch reports the signal that ended the process',
  { ...CASE, skip: process.platform === 'win32' && 'POSIX signals only' },
  async () => {
    const result = await launch({ command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGTERM')"] });
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: null, signal: 'SIGTERM' });
  },
);

test('launch keeps the stderr tail', CASE, async () => {
  const result = await launch({
    command: process.execPath,
    args: ['-e', "process.stderr.write('x'.repeat(1_000_000) + 'the end'); process.exitCode = 1"],
  });
  assert.deepEqual(
    { code: result.code, end: result.stderrTail.slice(-7), kept: result.stderrTail.length < 1_000_000 },
    { code: 1, end: 'the end', kept: true },
  );
});

test('launch reports the containment kind before it resolves', CASE, async () => {
  const seen: string[] = [];
  const reported: unknown[] = [];
  const result = await launch({
    command: process.execPath,
    args: ['-e', ''],
    onStarted: (containment) => {
      seen.push('started');
      reported.push(containment);
    },
  });
  seen.push('resolved');
  assert.deepEqual(seen, ['started', 'resolved']);
  assert.deepEqual(reported, [result.cleanup.containment]);
  assert.notEqual(result.cleanup.containment.kind, 'none', 'launched contained');
});

test("launch merges env over gg's environment", CASE, async () => {
  const lines: string[] = [];
  await launch({
    command: process.execPath,
    args: ['-e', "console.log(process.env.GG_LAUNCH_SETTING + ' ' + typeof process.env.PATH)"],
    env: { GG_LAUNCH_SETTING: 'given' },
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['given string']);
});

test('a launch whose executable cannot start rejects', CASE, async () => {
  await assert.rejects(launch({ command: join(scratch, 'no-such-program'), args: [] }), /ENOENT/);
});

// A directory first on PATH until the case ends.
function binOnPath(t: TestContext, name: string) {
  const bin = join(scratch, `${name}-bin`);
  mkdirSync(bin);
  caseEnv.caseEnv(t, { PATH: `${bin};${process.env.PATH}` });
  return bin;
}

// npm's shim and the script it names, as npm installs a package's bin. A shell would expand %OS% and eat the ^; run,
// launch's sibling, resolves the shim the same way.
test('a .cmd shim is resolved to the executable it names', WIN_CASE, async (t) => {
  const bin = binOnPath(t, 'shim');
  copyFileSync(SHIM, join(bin, 'argv-printer.cmd'));
  mkdirSync(join(bin, 'node_modules', 'argv-printer'), { recursive: true });
  writeFileSync(
    join(bin, 'node_modules', 'argv-printer', 'print.js'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  const lines: string[] = [];
  const launched = await launch({
    command: 'argv-printer',
    args: ['two words', '%OS%', 'a^b'],
    onLine: (line) => lines.push(line),
  });
  const ran = await exec
    .run('argv-printer', ['two words', '%OS%', 'a^b'])
    .catch((err: Error) => ({ stdout: err.message }));
  assert.deepEqual(
    { code: launched.code, lines, run: ran.stdout.trim() },
    { code: 0, lines: ['["two words","%OS%","a^b"]'], run: '["two words","%OS%","a^b"]' },
  );
});

test('a .cmd that is not an npm shim is refused, naming the file', WIN_CASE, async (t) => {
  const bin = binOnPath(t, 'plain');
  writeFileSync(join(bin, 'gg-plain-batch.cmd'), '@echo hi\r\n');
  const refused = /gg-plain-batch\.cmd is not an npm shim/;
  await assert.rejects(launch({ command: 'gg-plain-batch', args: [] }), refused);
  await assert.rejects(exec.run('gg-plain-batch', []), refused);
  // cmd-shim's form for a bin whose shebang names another program: gg would run it with node.
  writeFileSync(join(bin, 'gg-sh-shim.cmd'), readFileSync(SHIM, 'utf8').replace('_prog=node', '_prog=/bin/sh'));
  await assert.rejects(launch({ command: 'gg-sh-shim', args: [] }), /gg-sh-shim\.cmd is not an npm shim/);
  // cmd-shim's form for a node bin whose shebang sets a variable: gg would run it without the variable.
  const envShim = readFileSync(SHIM, 'utf8').replace('CALL :find_dp0', 'CALL :find_dp0\r\n@SET NODE_OPTIONS=x');
  writeFileSync(join(bin, 'gg-env-shim.cmd'), envShim);
  await assert.rejects(launch({ command: 'gg-env-shim', args: [] }), /gg-env-shim\.cmd is not an npm shim/);
});

// A relative shim path or PATH entry names a file in the child's working directory, as spawn reads it, not gg's.
test('a relative shim path or PATH entry is found from the working directory', WIN_CASE, async () => {
  const cwd = mkdtempSync(join(scratch, 'relative-'));
  const bin = join(cwd, 'bin');
  mkdirSync(join(bin, 'node_modules', 'argv-printer'), { recursive: true });
  copyFileSync(SHIM, join(bin, 'tool.cmd'));
  writeFileSync(
    join(bin, 'node_modules', 'argv-printer', 'print.js'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  const ran = (command: string, env?: Record<string, string>) =>
    exec.run(command, ['x'], { cwd, env }).then(
      (result) => result.stdout.trim(),
      (err: Error) => err.message,
    );
  const lines: string[] = [];
  const launched = await launch({
    command: './bin/tool.cmd',
    args: ['x'],
    cwd,
    onLine: (line) => lines.push(line),
  }).then(
    (result) => ({ code: result.code, lines }),
    (err: Error) => err.message,
  );
  assert.deepEqual(
    {
      dotted: await ran('./bin/tool.cmd'),
      backslashed: await ran('bin\\tool.cmd'),
      onPath: await ran('tool', { PATH: `bin;${process.env.PATH}` }),
      launched,
    },
    { dotted: '["x"]', backslashed: '["x"]', onPath: '["x"]', launched: { code: 0, lines: ['["x"]'] } },
  );
});

// spawn throws at once for a .bat or .cmd it is handed, which only a shell runs; behind the Windows gate too, the
// launch rejects with that error, as run does.
test('a .bat the shim lookup does not find rejects with the spawn error', WIN_CASE, async () => {
  const missing = join(scratch, 'no-such-dir', 'tool.bat');
  await assert.rejects(exec.run(missing, []), { code: 'EINVAL' });
  await assert.rejects(launch({ command: missing, args: [] }), { code: 'EINVAL' });
});

// Every way a launch's startup meets a stop (#423 review round 2). Each settles; onStarted runs at most once, before
// the result, and only when a process was started; a launch whose spawn failed rejects with that error. A row marked
// prompt starts nothing gg must wait on, or meets a stop the job refused, so it settles within one turn of the event
// loop after the spawn error or the stop: a launch still pending then would wait on a gate that may never answer.
const windows = process.platform === 'win32';
const STARTUP_ROWS: {
  name: string;
  skip?: string | false;
  refused?: boolean;
  launch: () => exec.LaunchOptions;
  prompt: boolean;
  expected: Record<string, unknown>;
}[] = [
  {
    name: 'started, no stop',
    launch: () => ({ command: process.execPath, args: ['-e', ''] }),
    prompt: false,
    expected: { outcome: 'resolved', cancelled: false, timedOut: null, events: ['started', 'result'] },
  },
  {
    name: 'started, cancelled before the launch',
    launch: () => ({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      signal: AbortSignal.abort(),
    }),
    prompt: false,
    expected: { outcome: 'resolved', cancelled: true, timedOut: null, confirmed: true, events: ['started', 'result'] },
  },
  {
    name: 'started, a 1 ms wall clock',
    launch: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], wallMs: 1 }),
    prompt: false,
    expected: {
      outcome: 'resolved',
      cancelled: false,
      timedOut: 'wall',
      confirmed: true,
      events: ['started', 'result'],
    },
  },
  {
    name: 'missing executable, no stop',
    launch: () => ({ command: join(scratch, 'no-such-program'), args: [] }),
    prompt: !windows,
    expected: { outcome: 'rejected', code: 'ENOENT', events: ['result'] },
  },
  {
    // On Windows the stop ends the gate before it tries the argv, so the stop is the result (D2).
    name: 'missing executable, cancelled before the launch',
    launch: () => ({ command: join(scratch, 'no-such-program'), args: [], signal: AbortSignal.abort() }),
    prompt: !windows,
    expected: windows
      ? { outcome: 'resolved', cancelled: true, timedOut: null, events: ['started', 'result'] }
      : { outcome: 'rejected', code: 'ENOENT', events: ['result'] },
  },
  {
    name: 'missing working directory, cancelled before the launch',
    launch: () => ({
      command: process.execPath,
      args: ['-e', ''],
      cwd: join(scratch, 'no-such-dir'),
      signal: AbortSignal.abort(),
    }),
    prompt: true,
    expected: { outcome: 'rejected', code: 'ENOENT', events: ['result'] },
  },
  {
    name: 'termination refused, cancelled before the launch',
    skip: !windows && 'a Windows job only',
    refused: true,
    launch: () => ({ command: process.execPath, args: ['-e', ''], signal: AbortSignal.abort() }),
    prompt: true,
    expected: { outcome: 'resolved', cancelled: true, timedOut: null, confirmed: false, events: ['started', 'result'] },
  },
];

for (const row of STARTUP_ROWS)
  test(
    `launch startup meets a stop: ${row.name}`,
    { ...UNSANDBOXED_CASE, skip: UNSANDBOXED_CASE.skip || row.skip },
    async (t) => {
      const doubles = row.refused ? kernel32Doubles.refusedTermination() : null;
      if (doubles) t.after(() => doubles.members.forEach(processProbe.endProcess));
      const run = doubles ? exec.createExec({ kernel32: doubles.kernel32 }).launch : launch;
      const events: string[] = [];
      // From a Promise continuation, as a Harness calls it: a pre-aborted signal's stop comes before the spawn error.
      const settled = Promise.resolve().then((): Promise<Record<string, unknown>> =>
        run({ ...row.launch(), onStarted: () => void events.push('started') }).then(
          (result) => ({
            outcome: 'resolved',
            cancelled: result.cancelled,
            timedOut: result.timedOut,
            ...('confirmed' in row.expected && { confirmed: result.cleanup.confirmed }),
          }),
          (err: NodeJS.ErrnoException) => ({ outcome: 'rejected', code: err.code }),
        ),
      );
      const oneTurn = new Promise<Record<string, unknown>>((turned) =>
        setImmediate(() => setImmediate(() => turned({ outcome: 'pending' }))),
      );
      const got = await (row.prompt ? Promise.race([settled, oneTurn]) : settled);
      events.push('result');
      assert.deepEqual({ ...got, events }, row.expected);
      // a gate the refused stop left running answers later: once it has ended, onStarted must not have run again
      if (doubles)
        await processProbe.waitFor(() => [...doubles.members].every((pid) => !processProbe.alive(pid)), t.signal);
      assert.deepEqual(events, row.expected.events);
    },
  );
