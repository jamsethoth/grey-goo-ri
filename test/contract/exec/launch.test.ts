// lib/exec.ts's launch on every platform: an argv run contained, with no shell, under its stall and wall clocks and the
// cancel signal, its whole tree taken down when it stops (#423). The .cmd shim cases are Windows', where shims exist.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('launch stops a process silent past stallMs and says stall', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'stall.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const result = await launch({ command: process.execPath, args: [childScripts.LONG_LIVED, pidFile], stallMs: 500 });
  assert.deepEqual({ timedOut: result.timedOut, cancelled: result.cancelled }, { timedOut: 'stall', cancelled: false });
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
  const result = await launch({
    command: process.execPath,
    args: [
      '-e',
      "console.log('a'); setTimeout(() => { console.log('b'); setTimeout(() => process.exit(0), 300); }, 2500);",
    ],
    stallMs: 2000,
    onLine: (line) => line === 'b' && sawB(),
    onIdle: async () => {
      await seenB;
      return null;
    },
  });
  assert.deepEqual({ code: result.code, timedOut: result.timedOut }, { code: 0, timedOut: null });
});

test('launch stops a process past wallMs and says wall', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'wall.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile],
    stallMs: 60_000,
    wallMs: 500,
  });
  assert.deepEqual({ timedOut: result.timedOut, cancelled: result.cancelled }, { timedOut: 'wall', cancelled: false });
});

test('an aborted signal stops the process and says cancelled', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'cancel.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const controller = new AbortController();
  const result = await launch({
    command: process.execPath,
    args: [childScripts.LONG_LIVED, pidFile, 'started'],
    signal: controller.signal,
    onLine: () => controller.abort(),
  });
  assert.deepEqual({ timedOut: result.timedOut, cancelled: result.cancelled }, { timedOut: null, cancelled: true });
});

// The grandchild starts before its parent prints, so a launcher that contained the process only once it spoke would
// miss it; the parent's line cancels the launch.
test('a grandchild started before the first output line is killed with its tree', UNSANDBOXED_CASE, async (t) => {
  const pidFile = join(scratch, 'grandchild.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
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
  await assert.rejects(launch({ command: 'gg-plain-batch', args: [] }), /gg-plain-batch\.cmd/);
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
    },
  );
