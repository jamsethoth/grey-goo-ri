// lib/exec.ts's contract on Windows: the job object a command runs in, what is left when it cannot be set up, and the
// command a finished job leaves running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../../../lib/exec.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as manualTimers from '../../support/manual-timers.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';
import * as timedOutShell from '../../support/timed-out-shell.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-exec-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { WIN_CASE } = options;
const { nodeCommand } = childScripts;
const { noJob, realKernel32, withKernel32 } = kernel32Doubles;
const { alive, pidIn, waitFor } = processProbe;
// taskkill refused, as a sandbox or an access check would answer
const refusedTaskkill: [string, string[]] = [process.execPath, ['-e', 'process.exit(1)']];

test(
  'runShell with a timeout reports, and leaves running, the background processes of a command that finished on its own',
  WIN_CASE,
  async (t) => {
    const pidFile = join(scratch, 'leftover-reported.pid');
    const result = await exec.runShell(
      nodeCommand(t, childScripts.DETACHED_CHILD, 'ignore', pidFile),
      timedOutShell.shellOptions({ timeoutMs: 20000, signal: timedOutShell.noClock() }),
    );
    assert.equal(result.code, 0);
    // a background process that never starts fails at the case timeout
    await waitFor(() => existsSync(pidFile), t.signal);
    const pid = pidIn(pidFile);
    try {
      assert.ok(result.leftovers?.includes(pid), JSON.stringify(result.leftovers));
      assert.match(result.output, /left running: pid/);
      assert.ok(alive(pid), 'background process was killed');
    } finally {
      processProbe.endProcess(pid);
    }
  },
);

// The job's second limit change, the one that drops kill-on-close, fails: closing the job's handle would then kill the
// background process runShell reports as left running.
test(
  "runShell: when the job cannot let a finished command's leftovers run on, " +
    'it keeps them running and says they end with gg',
  WIN_CASE,
  async (t) => {
    const pidFile = join(scratch, 'kept.pid');
    t.after(() => processProbe.endProcessIn(pidFile));
    let limitChanges = 0;
    const kernel32 = withKernel32({
      SetInformationJobObject: (...limits) =>
        ++limitChanges === 1 ? (realKernel32?.SetInformationJobObject(...limits) ?? 0) : 0,
    });
    const result = await exec
      .createExec({ kernel32 })
      .runShell(nodeCommand(t, childScripts.DETACHED_CHILD, 'ignore', pidFile), { timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.output);
    assert.equal(limitChanges, 2, 'kill-on-close was never dropped');
    assert.ok(result.leftovers?.includes(pidIn(pidFile)), JSON.stringify(result.leftovers));
    assert.match(result.output, /they end when gg exits/);
    assert.ok(alive(pidIn(pidFile)), 'the leftover was killed with the job');
  },
);

test(
  'runShell: a child that asks to break away from the job still starts, and is left outside the timeout kill',
  WIN_CASE,
  async (t) => {
    const created = join(scratch, 'breakaway.created');
    const sleeperPid = join(scratch, 'ba-sleeper.pid');
    const { result } = await timedOutShell.timeOutWhen(
      nodeCommand(
        t,
        '--disable-warning=ExperimentalWarning',
        childScripts.BREAKAWAY_CHILD,
        created,
        childScripts.LONG_LIVED,
        sleeperPid,
      ),
      { timeoutMs: 6000 },
      () => existsSync(created),
      t.signal,
    );
    const match = result.output.match(/created pid=(\d+)/);
    const pid = match && Number(match[1]);
    try {
      assert.ok(match, `breakaway request was refused: ${result.output}`);
      assert.equal(result.timedOut, true);
      assert.ok(alive(pid as number), 'a child that broke away on purpose should be outside the job');
      assert.ok(
        !result.survivors.some((survivor) => survivor.pid === pid),
        'an escaped child is not a survivor of the job',
      );
    } finally {
      if (pid) processProbe.endProcess(pid);
    }
  },
);

test(
  'runShell: when the job cannot be set up, the timeout still takes down the process tree ' +
    'and says orphans are not contained',
  options.UNSANDBOXED_WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob');
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: noJob() },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? pidIn(pidFile) : null;
    try {
      assert.equal(result.timedOut, true);
      assert.ok(
        result.cleanupErrors.some((error) => /job object unavailable/.test(error)),
        JSON.stringify(result.cleanupErrors),
      );
      assert.ok(pid, 'child never started');
      // a child still linked to the shell that is left running fails at the case timeout
      await waitFor(() => !alive(pid), t.signal);
    } finally {
      if (pid) processProbe.endProcess(pid);
    }
  },
);

test(
  'in a restricted sandbox, when the job cannot be set up, the timeout takes down or names the process tree ' +
    'and says orphans are not contained',
  options.SANDBOXED_WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob-sandboxed');
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: noJob() },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? pidIn(pidFile) : null;
    try {
      assert.equal(result.timedOut, true);
      assert.ok(
        result.cleanupErrors.some((error) => /job object unavailable/.test(error)),
        JSON.stringify(result.cleanupErrors),
      );
      assert.ok(pid, 'child never started');
      // a child still linked to the shell that is neither killed nor named with an error fails at the case timeout
      await waitFor(
        () => !alive(pid) || result.survivors.some((survivor) => survivor.pid === pid && survivor.error),
        t.signal,
      );
    } finally {
      if (pid) processProbe.endProcess(pid);
    }
  },
);

// A loaded machine can take seconds over taskkill /T. Stopped partway it may have killed the shell but not the children
// it can then no longer find, so a slow taskkill must be let finish, however slow: this one takes longer than the 30 s
// ceiling runShell once had. The seam gets the pid to kill as its last argument.
test(
  'runShell: when the job cannot be set up, a slow taskkill still takes down the process tree',
  WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob-slow');
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: noJob(), taskkillCommand: [process.execPath, [childScripts.SLOW_TASKKILL]] },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? pidIn(pidFile) : null;
    try {
      assert.equal(result.timedOut, true);
      assert.ok(pid, 'child never started');
      assert.ok(!result.cleanupErrors.some((error) => /taskkill/.test(error)), JSON.stringify(result.cleanupErrors));
      // a child still linked to the shell that is left running fails at the case timeout
      await waitFor(() => !alive(pid), t.signal);
    } finally {
      for (const survivor of result.survivors) processProbe.endProcess(survivor.pid);
      if (pid) processProbe.endProcess(pid);
    }
  },
);

test(
  'runShell: when the job cannot be set up and taskkill is refused, the children still linked to the shell are named',
  WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob-denied');
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: noJob(), taskkillCommand: refusedTaskkill },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? pidIn(pidFile) : null;
    try {
      assert.equal(result.timedOut, true);
      assert.ok(pid, 'child never started');
      assert.ok(
        result.survivors.some((survivor) => survivor.pid === pid),
        `linked child ${pid} missing from ${JSON.stringify(result.survivors)}`,
      );
      assert.ok(
        result.cleanupErrors.some((error) => /taskkill/.test(error)),
        JSON.stringify(result.cleanupErrors),
      );
    } finally {
      for (const survivor of result.survivors) processProbe.endProcess(survivor.pid);
      if (pid) processProbe.endProcess(pid);
    }
  },
);

// taskkill /T ends the children first and cmd.exe can exit on its own once they go, so the kill of the shell fails: 9
// of 120 takedowns under load, as "Access is denied" or "no running instance" (#285). What is left alive decides.
test(
  'runShell: when the job cannot be set up, a taskkill that fails with the tree down reports no failure',
  WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob-tree-down');
    t.after(() => processProbe.endProcessIn(pidFile)); // its starter ends with it
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      {
        timeoutMs: 4000,
        kernel32: noJob(),
        taskkillCommand: [process.execPath, [childScripts.FAILING_TASKKILL, 'tree']],
      },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.ok(ready, `child never started: ${result.output}`);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.survivors, []);
    assert.ok(!result.cleanupErrors.some((error) => /taskkill/.test(error)), JSON.stringify(result.cleanupErrors));
  },
);

test(
  'runShell: when the job cannot be set up, a taskkill that fails with a child left names it, not the gone shell',
  WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'nojob-child-left');
    t.after(() => processProbe.endProcessIn(pidFile)); // its starter ends with it
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      {
        timeoutMs: 4000,
        kernel32: noJob(),
        taskkillCommand: [process.execPath, [childScripts.FAILING_TASKKILL, 'shell']],
      },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    const pid = pidIn(pidFile);
    assert.ok(ready, `child never started: ${result.output}`);
    assert.ok(
      result.survivors.some((survivor) => survivor.pid === pid),
      `linked child ${pid} missing from ${JSON.stringify(result.survivors)}`,
    );
    assert.ok(
      result.survivors.every((survivor) => alive(survivor.pid)),
      `a process already gone is named as a survivor: ${JSON.stringify(result.survivors)}`,
    );
    assert.ok(
      result.cleanupErrors.some((error) => /taskkill/.test(error)),
      JSON.stringify(result.cleanupErrors),
    );
  },
);

// With no listing, what taskkill left cannot be known, so its failure is reported even with the shell gone.
test(
  'runShell: when node:ffi is unavailable, a taskkill that fails with the shell gone is reported',
  options.UNSANDBOXED_WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'noffi-shell-gone');
    t.after(() => processProbe.endProcessIn(pidFile));
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      {
        timeoutMs: 4000,
        kernel32: null,
        taskkillCommand: [process.execPath, [childScripts.FAILING_TASKKILL, 'shell']],
      },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.ok(ready, `child never started: ${result.output}`);
    assert.deepEqual(result.survivors, [], 'the shell is gone, and nothing else can be named with no listing');
    assert.ok(
      result.cleanupErrors.some((error) => /taskkill/.test(error)),
      JSON.stringify(result.cleanupErrors),
    );
  },
);

// The leftover holds the output pipes, so they never close: runShell answers once the command exits. Its clock moves
// only when the case moves it, so the call cannot end by timing out; the case moves it past the timeout only once
// the call has answered, when a timer the finish left armed would fire.
test(
  'runShell: a command that finishes is not reported as timed out ' +
    'while its leftover process still holds the output pipes',
  WIN_CASE,
  async (t) => {
    const pidFile = join(scratch, 'drain.pid');
    t.after(() => processProbe.endProcessIn(pidFile));
    const timers = manualTimers.manualTimers();
    const result = await exec.runShell(
      nodeCommand(t, childScripts.DETACHED_CHILD, 'inherit', pidFile),
      timedOutShell.shellOptions({ timeoutMs: 1, timers }),
    );
    assert.equal(result.timedOut, undefined, 'a finished command was reported as timed out');
    assert.equal(result.code, 0);
    timers.tick(1); // past the timeout: a clock the finish left armed fires now
    assert.equal(timers.fired(), 0, 'a timeout ran after the command finished');
  },
);

test(
  'runShell: an unreadable job membership is reported as unverified, never as a clean cleanup',
  WIN_CASE,
  async (t) => {
    const pidFile = join(scratch, 'queryfail.pid');
    const { result } = await timedOutShell.timeOutWhen(
      nodeCommand(t, childScripts.LONG_LIVED, pidFile),
      { timeoutMs: 3000, kernel32: withKernel32({ QueryInformationJobObject: () => 0 }) },
      () => existsSync(pidFile),
      t.signal,
    );
    assert.equal(result.timedOut, true);
    assert.ok(
      result.cleanupErrors.some((error) => /could not verify the job is empty/.test(error)),
      JSON.stringify(result.cleanupErrors),
    );
    assert.ok(
      result.survivors.length > 0 && result.survivors.every((survivor) => /not verified gone/.test(survivor.error)),
      JSON.stringify(result.survivors),
    );
    assert.match(result.output, /cleanup incomplete/);
  },
);

test('runShell: job membership larger than the first query buffer is still listed in full', WIN_CASE, async (t) => {
  // The job answers as one with more members than the first list holds: a query with room for fewer than 65 pids
  // fails with ERROR_MORE_DATA and says how many it holds, so only a list that grows past 64 entries is read.
  const moreData = 234; // ERROR_MORE_DATA
  let refused = 0;
  let lastError: number | null = null;
  const kernel32 = withKernel32({
    TerminateJobObject: () => 0,
    GetLastError: () => lastError ?? realKernel32?.GetLastError() ?? 0,
    QueryInformationJobObject: (...query) => {
      const [, , buffer, length] = query;
      lastError = null;
      if (length >= 8 + 8 * 65) return realKernel32?.QueryInformationJobObject(...query) ?? 0;
      refused++;
      (buffer as Buffer).writeUInt32LE(65, 0);
      lastError = moreData;
      return 0;
    },
  });
  const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'smallbuf', { kernel32 });
  try {
    assert.ok(refused > 0, 'no list was too small');
    assert.ok(result.survivors.length >= 3, JSON.stringify(result.survivors)); // shell, top and grandchild
    assert.ok(
      result.survivors.some((survivor) => survivor.pid === pid),
      JSON.stringify(result.survivors),
    );
  } finally {
    for (const survivor of result.survivors) processProbe.endProcess(survivor.pid);
  }
});

// The PowerShell job helper wrote these notes into the command's own streams, so a command could forge them: a fail
// note turned an exit 0 into 127, and an empty survivors note with done markers read as a clean cleanup.
test(
  "a command that prints lines like the job helper's notes cannot change its cleanup report",
  WIN_CASE,
  async (t) => {
    const finished = await exec.runShell(nodeCommand(t, childScripts.FORGED_JOB_NOTES, 'fail'), { timeoutMs: 60_000 });
    assert.equal(finished.code, 0, finished.output);
    assert.doesNotMatch(finished.output, /could not start command/);

    const pidFile = join(scratch, 'forged-clean.pid');
    t.after(() => processProbe.endProcessIn(pidFile));
    const { result } = await timedOutShell.timeOutWhen(
      nodeCommand(t, childScripts.FORGED_JOB_NOTES, 'clean', pidFile),
      { timeoutMs: 3000, kernel32: withKernel32({ TerminateJobObject: () => 0 }) },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.equal(result.timedOut, true);
    assert.ok(
      result.survivors.some((survivor) => survivor.pid === pidIn(pidFile)),
      `the forged notes hid ${pidIn(pidFile)}: ${JSON.stringify(result.survivors)}`,
    );
    assert.match(result.output, /cleanup incomplete/);
  },
);

test(
  'when node:ffi is unavailable, the timeout takes down the process tree and says orphans are not contained',
  options.UNSANDBOXED_WIN_CASE,
  async (t) => {
    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'noffi');
    t.after(() => processProbe.endProcessIn(pidFile));
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: null },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.ok(ready, `child never started: ${result.output}`);
    assert.equal(result.timedOut, true);
    assert.equal(result.containment, 'none');
    assert.ok(
      result.cleanupErrors.some((error) => /orphaned descendants are not contained/.test(error)),
      JSON.stringify(result.cleanupErrors),
    );
    // a child still linked to the shell that is left running fails at the case timeout
    await waitFor(() => !alive(pidIn(pidFile)), t.signal);
  },
);

// cmd.exe reads a gate line before the command runs; an empty line would leave its error level at 1, which a bare
// `exit /b` or `if errorlevel` in the command reads.
test(
  'runShell: the command starts as in a fresh shell, with no error level and no gate variable',
  WIN_CASE,
  async () => {
    const line =
      '(if errorlevel 1 (echo LEVEL1) else (echo LEVEL0)) & ' +
      '(if defined GG_GATE (echo DEFINED) else (echo UNDEFINED)) & exit /b';
    for (const runShell of [exec.runShell, exec.createExec({ kernel32: null }).runShell]) {
      const result = await runShell(line, { timeoutMs: 60_000 });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /LEVEL0/);
      assert.match(result.output, /UNDEFINED/);
    }
  },
);

// bin/gg.ts opens kernel32 and passes it down (ADR 0019); a module that imports exec must not open a second one.
// A query string loads a fresh copy of exec.ts, so its import is seen here.
test('importing exec opens no node:ffi, and its own runShell opens it on the first call', WIN_CASE, async (t) => {
  const getBuiltinModule = process.getBuiltinModule;
  const opened: string[] = [];
  process.getBuiltinModule = ((id: string) => {
    opened.push(id);
    return getBuiltinModule.call(process, id);
  }) as typeof process.getBuiltinModule;
  t.after(() => (process.getBuiltinModule = getBuiltinModule));
  const fresh: typeof exec = await import(`../../../lib/exec.ts?import-${Date.now()}`);
  assert.deepEqual(opened, [], 'opened at import');
  const result = await fresh.runShell('echo ran', { timeoutMs: 60_000 });
  assert.equal(result.containment, 'job', result.output);
  assert.deepEqual(opened, ['node:ffi']);
});

// libuv looks a bare program name up in the child's working directory before PATH unless gg's own environment sets
// NoDefaultCurrentDirectoryInExePath, so node.exe is planted there under the shell's and taskkill's names. taskkill
// starts in gg's working directory, so the case moves there too.
test(
  'runShell runs cmd.exe and taskkill.exe from System32, not copies planted in the working directory',
  options.UNSANDBOXED_WIN_CASE,
  async (t) => {
    const planted = mkdtempSync(join(scratch, 'planted-'));
    for (const name of ['cmd.exe', 'taskkill.exe'])
      try {
        linkSync(process.execPath, join(planted, name));
      } catch {
        copyFileSync(process.execPath, join(planted, name)); // another volume
      }
    const noSearch = process.env.NoDefaultCurrentDirectoryInExePath;
    const home = process.cwd();
    t.after(() => {
      process.chdir(home);
      if (noSearch !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = noSearch;
    });
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    process.chdir(planted);
    const result = await exec.runShell('echo real', { cwd: planted, timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /real/);

    const { pidFile, commandLine } = childScripts.linkedChild(t, scratch, 'planted');
    let survivors: { pid: number }[] = [];
    t.after(() => {
      // a runShell whose taskkill was the planted one leaves the shell running, in the planted directory
      for (const { pid } of survivors)
        spawnSync(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
        });
      processProbe.endProcessIn(pidFile);
    });
    const { result: timedOut, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 4000, kernel32: noJob() },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    survivors = timedOut.survivors;
    assert.ok(ready, `child never started: ${timedOut.output}`);
    assert.ok(!timedOut.cleanupErrors.some((error) => /taskkill/.test(error)), JSON.stringify(timedOut.cleanupErrors));
    await waitFor(() => !alive(pidIn(pidFile)), t.signal); // a child taskkill never reached fails at the case timeout
  },
);
