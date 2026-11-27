import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as containment from '../../../lib/containment.ts';
import * as exec from '../../../lib/exec.ts';
import * as runSuite from '../../../scripts/run-suite.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';

const { pidIn } = processProbe;
const ascending = (left: number, right: number) => left - right;

// A shell in a job, with a sleeper it started: the job, and the two pids in ascending order.
async function shellWithSleeper(t: TestContext, kernel32: containment.Kernel32 | null) {
  const directory = mkdtempSync(join(tmpdir(), 'gg-containment-'));
  const pidFile = join(directory, 'sleeper.pid');
  const { child, job } = containment.start(
    kernel32,
    childScripts.nodeCommand(t, childScripts.LONG_LIVED, pidFile),
    undefined,
  );
  assert.ok(job, 'the job was not set up');
  // first in, first out: the processes are gone before their directory is removed
  t.after(async () => {
    job.terminate();
    await job.emptied();
    job.close();
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  child.stdout?.resume();
  child.stderr?.resume();
  // a sleeper that never starts fails at the case timeout
  await processProbe.waitFor(() => pidIn(pidFile) > 0, t.signal);
  return { job, shellPid: child.pid ?? 0, held: [child.pid ?? 0, pidIn(pidFile)].sort(ascending) };
}

// While the shell runs, its job holds the shell and the sleeper, and the console host CREATE_NO_WINDOW gave it unless
// that host started before the job was set up. All are alive, so only the console host's name and parent tell it apart.
test('a job names the processes it holds, leaving out the console host of its shell', options.WIN_CASE, async (t) => {
  const { job, shellPid, held } = await shellWithSleeper(t, kernel32Doubles.realKernel32);
  const others = job.members().filter((pid) => !held.includes(pid));
  assert.ok(others.length <= 1, `besides the shell and the sleeper, at most the console host: ${others}`);
  assert.deepEqual(job.leftovers(shellPid).sort(ascending), held);
});

// The console host starts as cmd.exe does, so it can beat the job to it: 4 of 150 starts on a loaded machine (#285).
// The wait is bounded because node:test cannot time out a case that never yields; running out fails the members assert.
test('a console host that started before the job was set up stays outside it', options.WIN_CASE, async (t) => {
  const real = kernel32Doubles.realKernel32;
  assert.ok(real, 'node:ffi is unavailable');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const afterConsoleHost = kernel32Doubles.withKernel32({
    OpenProcess(access, inherit, pid) {
      for (let tries = 0; tries < 6000 && !containment.linkedDescendants(real, pid).length; tries++)
        Atomics.wait(pause, 0, 0, 10);
      return real.OpenProcess(access, inherit, pid);
    },
  });
  const { job, shellPid, held } = await shellWithSleeper(t, afterConsoleHost);
  assert.deepEqual(job.members().sort(ascending), held);
  assert.deepEqual(job.leftovers(shellPid).sort(ascending), held);
});

test('describe names a running process by its start time and command line', options.WIN_CASE, async (t) => {
  const kernel32 = containment.openKernel32();
  const { shellPid } = await shellWithSleeper(t, kernel32);
  const named = containment.describe(kernel32, shellPid);
  assert.equal(named.pid, shellPid);
  assert.match(named.created ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.match(named.commandLine ?? '', /cmd\.exe/);
});

test('describe of a pid that is gone, or with no kernel32, names only the pid', options.WIN_CASE, () => {
  assert.deepEqual(containment.describe(containment.openKernel32(), 0xfffffffc), {
    pid: 0xfffffffc,
    created: null,
    commandLine: null,
  });
  assert.deepEqual(containment.describe(null, 7), { pid: 7, created: null, commandLine: null });
});

// The watcher linked a pid at one start; by the hold its pid names a process with another start, which is not the
// watcher's to adopt or end (#531). The same process at its own start is held and adopted into the job.
test('a job holds a process only at the start it was linked at', options.WIN_CASE, async (t) => {
  const kernel32 = containment.openKernel32() as containment.Kernel32;
  const { job } = await shellWithSleeper(t, kernel32);
  const directory = mkdtempSync(join(tmpdir(), 'gg-hold-'));
  const pidFile = join(directory, 'outside.pid');
  spawn(process.execPath, [childScripts.LONG_LIVED, pidFile], { stdio: 'ignore' }).unref();
  t.after(() => processProbe.endProcessIn(pidFile));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await processProbe.waitFor(() => pidIn(pidFile) > 0, t.signal);
  const entry = { pid: pidIn(pidFile), parentPid: process.pid, exe: 'node.exe' };
  const started = containment.startOf(kernel32, entry.pid) as bigint;
  assert.equal(job.hold(entry, started + 1n), null);
  assert.ok(!job.members().includes(entry.pid), 'not adopted');
  assert.ok(processProbe.alive(entry.pid), 'not ended');
  assert.equal(job.hold(entry, started)?.held, true);
  assert.ok(job.members().includes(entry.pid), 'adopted into the job');
});

// After a failed none save the watcher holds an escapee to end it, never to adopt it (#532 Q2 A).
test("a job's hold to end a process ends it, unadopted", options.WIN_CASE, async (t) => {
  const kernel32 = containment.openKernel32() as containment.Kernel32;
  const { job } = await shellWithSleeper(t, kernel32);
  const directory = mkdtempSync(join(tmpdir(), 'gg-hold-'));
  const pidFile = join(directory, 'outside.pid');
  spawn(process.execPath, [childScripts.LONG_LIVED, pidFile], { stdio: 'ignore' }).unref();
  t.after(() => processProbe.endProcessIn(pidFile));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await processProbe.waitFor(() => pidIn(pidFile) > 0, t.signal);
  const entry = { pid: pidIn(pidFile), parentPid: process.pid, exe: 'node.exe' };
  assert.equal(job.hold(entry, containment.startOf(kernel32, entry.pid) as bigint, 'end')?.held, true);
  assert.ok(!job.members().includes(entry.pid), 'not adopted');
  const gone = AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]);
  await processProbe.waitFor(() => !processProbe.alive(entry.pid), gone).catch(() => {});
  assert.equal(processProbe.alive(entry.pid), false, 'ended');
});

// Every job gg creates, for a Check's shell runner, a launch and the suite launcher, sets kill-on-close alone, so a
// child that asks to break away fails to start (ADR 0030 decision 1). Each entry gives the limit flags of every job it
// set up. The suite launcher's job is never given this test process, as in test/contract/exec/run-suite.test.ts.
test('every job gg creates sets kill-on-close alone, with no breakaway', options.WIN_CASE, async (t) => {
  const real = kernel32Doubles.realKernel32 as containment.Kernel32;
  const flagsOf = async (
    enter: (kernel32: containment.Kernel32) => Promise<unknown>,
    replaced: Parameters<typeof kernel32Doubles.withKernel32>[0] = {},
  ) => {
    const flags: number[] = [];
    const recorded = kernel32Doubles.withKernel32({
      SetInformationJobObject: (...call) => {
        flags.push((call[2] as Buffer).readUInt32LE(16)); // the limit flags, at byte 16 of the extended limits
        return real.SetInformationJobObject(...call);
      },
      ...replaced,
    });
    await enter(recorded);
    return flags;
  };
  let stageJob = 0n;
  t.after(() => real.CloseHandle(stageJob));
  const killOnJobClose = 0x2000;
  assert.deepEqual(
    {
      "a Check's shell runner": await flagsOf((kernel32) =>
        exec
          .createExec({ kernel32 })
          .runShell(childScripts.nodeCommand(t, childScripts.PRINTS_LINE, 'ran'), { timeoutMs: 60_000 }),
      ),
      'a launch': await flagsOf((kernel32) =>
        exec.createExec({ kernel32 }).launch({ command: process.execPath, args: ['-e', ''], wallMs: 60_000 }),
      ),
      'the suite launcher': await flagsOf((kernel32) => runSuite.holdStage(kernel32), {
        CreateJobObjectW: (...args) => (stageJob = real.CreateJobObjectW(...args)),
        AssignProcessToJobObject: () => 1,
      }),
    },
    {
      "a Check's shell runner": [killOnJobClose],
      'a launch': [killOnJobClose],
      'the suite launcher': [killOnJobClose],
    },
  );
});
