import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../lib/exec.mjs';
import * as render from '../lib/render.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'ff-exec-'));
const script = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Waits for fn() to hold; a case that waits for an event that never comes fails at its own timeout.
const waitFor = async (fn, ms = Infinity) => { const end = Date.now() + ms; while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 50)); return fn(); };

// Only a restricted sandbox may refuse cleanup; there survivors need only be reported.
const sandboxed = process.env.FF_TEST_SANDBOXED === '1';
// Cases that wait for a process event: a broken runShell fails at this bound instead of hanging the file.
const CASE = { timeout: 120_000 };
// How long a test process lives unless it is killed: longer than any case, so no command ends on its own first.
const LIVES_MS = 600_000;
const writesPid = (pidFile) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${LIVES_MS});`;

// Parent spawns a detached grandchild through an intermediate that lingers ~2 s (so the watcher sees the chain) and
// then exits, leaving the grandchild orphaned while the parent outlives the timeout. delayMs holds the spawn back.
function orphanScripts(name, { delayMs = 0 } = {}) {
  const pidFile = join(tmp, `${name}.pid`);
  const grandchild = script(`${name}-gc.mjs`, writesPid(pidFile));
  const middle = script(`${name}-mid.mjs`, `import { spawn } from 'node:child_process'; setTimeout(() => spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref(), ${delayMs}); setTimeout(() => {}, ${delayMs} + 2000);`);
  const top = script(`${name}-top.mjs`, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: 'ignore' }); setTimeout(() => {}, ${LIVES_MS});`);
  return { pidFile, cmd: `"${process.execPath}" "${top}"` };
}

// Runs commandLine with its timeout clock held until ready() holds, so the processes a case checks exist before the
// timeout fires however slowly they start. ready is false when the command ended first.
async function timeOutWhen(commandLine, options, ready) {
  const clock = new AbortController();
  let settled = false;
  const running = exec.runShell(commandLine, { ...options, signal: clock.signal }).finally(() => { settled = true; });
  while (!settled && !ready()) await new Promise((r) => setTimeout(r, 50));
  const wasReady = ready();
  clock.abort();
  return { res: await running, ready: wasReady };
}

// A clock that never starts: the command runs in the job, and only its own end ends it.
const noClock = () => new AbortController().signal;

// Calls onHelper with the job helper of the next runShell as it is spawned, so listeners it adds run before runShell's.
function beforeRunShell(t, onHelper) {
  const spawn = childProcess.spawn;
  const restore = () => { childProcess.spawn = spawn; syncBuiltinESMExports(); };
  t.after(restore);
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    if (args[0] === 'powershell.exe') { restore(); onHelper(child); }
    return child;
  };
  syncBuiltinESMExports();
}

test('run: child that exits early while 5 MB of stdin is written resolves/rejects with its exit code', async () => {
  const input = 'x'.repeat(5 * 1024 * 1024);
  const args = ['-e', 'process.exit(3)'];
  const res = await exec.run(process.execPath, args, { input, allowFail: true });
  assert.equal(res.code, 3);
  await assert.rejects(exec.run(process.execPath, args, { input }), (e) => e.code === 3);
});

test('run and runShell read a multi-byte character split across chunks exactly', async () => {
  const p = script('split.mjs', `process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 200);`);
  assert.equal((await exec.run(process.execPath, [p])).stdout.trim(), '€');
  assert.equal((await exec.runShell(`"${process.execPath}" "${p}"`)).output.trim(), '€');
});

// Not timed out is the promptness check: a command left waiting on stdin would run until the case timeout. A wall-clock
// bound here measured the Windows job helper's cold start (8 to 15 s early in a loaded suite), so it was dropped, with
// the owner's approval, from this ported case.
test('runShell: a command waiting for stdin EOF returns promptly', CASE, async () => {
  const p = script('stdin.mjs', `process.stdin.resume(); process.stdin.on('end', () => console.log('eof'));`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 20000, signal: noClock() });
  assert.ok(!res.timedOut);
  assert.match(res.output, /eof/);
});

test('runShell with a timeout still returns the exit code and output of a command that finishes', CASE, async () => {
  const p = script('exit7.mjs', `console.log('hi'); process.exit(7);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 20000, signal: noClock() });
  assert.equal(res.code, 7);
  assert.match(res.output, /hi/);
  assert.ok(!res.timedOut);
  assert.ok(!/FFJOB/.test(res.output));
  assert.equal(res.leftovers, undefined, 'a clean command must not report leftovers (e.g. its console host)');
});

// The budget is the case timeout: the command never ends on its own, so a runShell that waited for it could not pass.
test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', CASE, async () => {
  const p = script('sleep.mjs', `setInterval(() => {}, 60000);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
});

test('runShell: a timed-out command returns code null and the output it printed before the timeout', CASE, async () => {
  const printed = join(tmp, 'sentinel.printed');
  const p = script('sentinel.mjs', `import { writeFileSync } from 'node:fs'; console.log('SENTINEL-BEFORE-HANG'); writeFileSync(${JSON.stringify(printed)}, ''); setTimeout(() => {}, ${LIVES_MS});`);
  const { res } = await timeOutWhen(`"${process.execPath}" "${p}"`, { timeoutMs: 4000 }, () => existsSync(printed));
  assert.equal(res.code, null);
  assert.equal(res.timedOut, true);
  assert.match(res.output, /SENTINEL-BEFORE-HANG/);
});

test('runShell timeout kills descendants by PID, including one whose parent already exited', CASE, async () => {
  const { pidFile, cmd } = orphanScripts('orphan');
  const { res, ready } = await timeOutWhen(cmd, { timeoutMs: 3500 }, () => existsSync(pidFile));
  assert.equal(res.timedOut, true);
  assert.ok(ready, 'grandchild never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    // cleanup may be refused in a sandbox, but a descendant that is still running must be named with an error
    if (!(sandboxed && res.survivors.some((s) => s.pid === pid && s.error))) {
      if (!sandboxed) assert.deepEqual(res.survivors, []);
      await waitFor(() => !alive(pid)); // a descendant that is never killed fails at the case timeout
    }
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell timeout kills a descendant that starts later than the timeout would have fired', CASE, async () => {
  const { pidFile, cmd } = orphanScripts('orphan-late', { delayMs: 4000 });
  const { res, ready } = await timeOutWhen(cmd, { timeoutMs: 3500 }, () => existsSync(pidFile));
  assert.ok(ready, 'grandchild never started');
  assert.equal(res.timedOut, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    // cleanup may be refused in a sandbox, but a descendant that is still running must be named with an error
    if (!(sandboxed && res.survivors.some((s) => s.pid === pid && s.error))) {
      if (!sandboxed) assert.deepEqual(res.survivors, []);
      await waitFor(() => !alive(pid)); // a descendant that is never killed fails at the case timeout
    }
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell reports surviving PIDs and the kill error when termination fails', CASE, async () => {
  const { pidFile, cmd } = orphanScripts('refused');
  const { res } = await timeOutWhen(cmd, { timeoutMs: 3500, killPid: () => { throw new Error('EPERM refused'); }, denyTerminate: true }, () => existsSync(pidFile));
  assert.equal(res.timedOut, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.some((s) => s.pid === pid && /EPERM refused|withheld/.test(s.error)), JSON.stringify(res.survivors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {} // the withheld job leaves its root running too
    try { process.kill(pid); } catch {}
  }
});

test('runShell with a failed process snapshot reports known descendants as unverified, not as cleaned up', { ...CASE, skip: process.platform === 'win32' && 'Windows contains descendants with a job object, no snapshot' }, async () => {
  const { pidFile, cmd } = orphanScripts('nosnap');
  const { res } = await timeOutWhen(cmd, { timeoutMs: 3500, killPid: () => { throw new Error('EPERM refused'); }, snapshotCommand: [process.execPath, ['-e', 'process.exit(1)']] }, () => existsSync(pidFile));
  assert.equal(res.timedOut, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.some((s) => s.pid === pid), JSON.stringify(res.survivors));
    assert.ok(res.cleanupErrors.length > 0);
    assert.match(res.output, /cleanup incomplete/);
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell with a timeout leaves background processes of a command that finished on its own running', CASE, async () => {
  const { pidFile } = orphanScripts('leftover');
  const quit = script('leftover-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(join(tmp, 'leftover-gc.mjs'))}], { detached: true, stdio: 'ignore' }).unref();`);
  const res = await exec.runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 20000, signal: noClock() });
  assert.equal(res.code, 0);
  await waitFor(() => existsSync(pidFile)); // a background process that never starts fails at the case timeout
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    if (process.platform === 'win32') { // reported, not killed
      assert.ok(res.leftovers?.includes(pid), JSON.stringify(res.leftovers));
      assert.match(res.output, /left running: pid/);
    }
    // shortcut: an absence check, so a kill still landing after this pause is missed, never a false failure
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(pid), 'background process was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell: a child that asks to break away from the job still starts, and is left outside the timeout kill', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const sleeper = script('ba-sleeper.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
  const created = join(tmp, 'breakaway.created');
  const ps = script('breakaway.ps1', `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class BA {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r2p, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  public static string Run(string cmd) {
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
    bool ok = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x01000000, IntPtr.Zero, null, ref si, out pi); // CREATE_BREAKAWAY_FROM_JOB
    return ok ? "created pid=" + pi.pid : "failed win32error=" + Marshal.GetLastWin32Error();
  }
}
'@
$r = [BA]::Run('"${process.execPath}" "${sleeper}"')
[Console]::Out.WriteLine($r); [Console]::Out.Flush()
Set-Content -LiteralPath '${created}' -Value $r
Start-Sleep ${LIVES_MS / 1000}
`);
  const { res } = await timeOutWhen(`powershell.exe -NoProfile -NonInteractive -File "${ps}"`, { timeoutMs: 6000 }, () => existsSync(created));
  const m = res.output.match(/created pid=(\d+)/);
  const pid = m && Number(m[1]);
  try {
    assert.ok(m, `breakaway request was refused: ${res.output}`);
    assert.equal(res.timedOut, true);
    assert.ok(alive(pid), 'a child that broke away on purpose should be outside the job');
    assert.ok(!res.survivors.some((s) => s.pid === pid), 'an escaped child is not a survivor of the job');
  } finally {
    if (pid) try { process.kill(pid); } catch {}
  }
});

const withEnv = async (env, fn) => {
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
};

// A shell whose child writes pidFile; the child starts delayMs after the shell.
function linkedChild(name, { delayMs = 0 } = {}) {
  const pidFile = join(tmp, `${name}.pid`);
  const child = script(`${name}-child.mjs`, writesPid(pidFile));
  const top = script(`${name}-top.mjs`, `import { spawn } from 'node:child_process'; setTimeout(() => spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' }), ${delayMs}); setTimeout(() => {}, ${LIVES_MS});`);
  return { pidFile, cmd: `"${process.execPath}" "${top}"` };
}

test('runShell: when the job cannot be set up, the timeout still takes down the process tree and says orphans are not contained', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const { pidFile, cmd } = linkedChild('nojob');
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000 }, () => existsSync(pidFile)));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.cleanupErrors.some((e) => /job object unavailable/.test(e)), JSON.stringify(res.cleanupErrors));
    assert.ok(pid, 'child never started');
    // a child still linked to the shell that is left running fails at the case timeout, unless a sandbox names it
    if (!(sandboxed && res.survivors.some((s) => s.pid === pid && s.error))) await waitFor(() => !alive(pid));
  } finally {
    if (pid) try { process.kill(pid); } catch {}
  }
});

// A loaded machine can take seconds over taskkill /T. Stopped partway it may have killed the shell but not the children
// it can then no longer find, so a slow taskkill must be let finish. The seam gets the pid to kill as its last argument.
test('runShell: when the job cannot be set up, a slow taskkill still takes down the process tree', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const { pidFile, cmd } = linkedChild('nojob-slow');
  const slow = script('slow-taskkill.mjs', `import { spawnSync } from 'node:child_process'; setTimeout(() => process.exit(spawnSync('taskkill', ['/T', '/F', '/PID', String(process.argv[2])]).status ?? 1), 2500);`);
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, [slow]] }, () => existsSync(pidFile)));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(pid, 'child never started');
    assert.ok(!res.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(res.cleanupErrors));
    await waitFor(() => !alive(pid)); // a child still linked to the shell that is left running fails at the case timeout
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
    if (pid) try { process.kill(pid); } catch {}
  }
});

test('runShell: when the job cannot be set up and taskkill is refused, the children still linked to the shell are named', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const { pidFile, cmd } = linkedChild('nojob-denied');
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] }, () => existsSync(pidFile)));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(pid, 'child never started');
    assert.ok(res.survivors.some((s) => s.pid === pid), `linked child ${pid} missing from ${JSON.stringify(res.survivors)}`);
    assert.ok(res.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(res.cleanupErrors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
    if (pid) try { process.kill(pid); } catch {}
  }
});

test('runShell: when the job cannot be set up and taskkill is refused, a child that starts later than the timeout would have fired is named', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const { pidFile, cmd } = linkedChild('nojob-late', { delayMs: 4500 });
  const { res } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] }, () => existsSync(pidFile)));
  // taskkill is refused, so the top process lives on and starts the child even when the timeout came first
  await waitFor(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.survivors.some((s) => s.pid === pid), `linked child ${pid} missing from ${JSON.stringify(res.survivors)}`);
    assert.ok(res.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(res.cleanupErrors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
    try { process.kill(pid); } catch {}
  }
});

// The clock starts as the helper exits, just before runShell sees that exit, and fires inside the 3 s drain window
// unless the exit stops it. The leftover holds the output pipes, so the drain runs its full length.
test('runShell: a command that finishes is not reported as timed out while its leftover process still holds the output pipes', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const sleeper = script('drain-sleeper.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
  const quit = script('drain-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached: true, stdio: 'inherit' }).unref();`);
  const clock = new AbortController();
  beforeRunShell(t, (helper) => helper.on('exit', () => clock.abort()));
  const res = await exec.runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 1, signal: clock.signal, drainMs: 3000 });
  try {
    assert.equal(res.timedOut, undefined, 'a finished command was reported as timed out');
    assert.equal(res.code, 0);
  } finally {
    for (const p of res.leftovers ?? []) try { process.kill(p); } catch {}
  }
});

// A cold Windows PowerShell and Add-Type took 3.5 s on a fresh runner and up to 15 s under the suite's load; that start-up
// must not be charged to the command's timeout. The case moves runShell's clock itself: a start-up that used all but
// 1 ms of the budget, then 2 ms more once runShell has seen the command start.
test('runShell: the timeout counts from when the command starts, not from the job helper start-up', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const go = join(tmp, 'counts.go');
  const p = script('counts.mjs', `import { existsSync } from 'node:fs'; const wait = setInterval(() => { if (existsSync(${JSON.stringify(go)})) { clearInterval(wait); console.log('done'); } }, 50);`);
  let seen;
  const started = new Promise((r) => (seen = r));
  let notes = '';
  beforeRunShell(t, (helper) => helper.stderr.on('data', (d) => { notes += d; if (notes.includes('\u0001FFJOB started')) seen(); }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 7000 });
  t.mock.timers.tick(6999);
  await started; // runShell's own listener ran right after this case's
  t.mock.timers.tick(2);
  writeFileSync(go, '');
  const res = await running;
  assert.equal(res.timedOut, undefined, `the command timed out on the helper's start-up: ${res.output}`);
  assert.equal(res.code, 0);
  assert.match(res.output, /done/);
});

// The stalled helper outlives the case, so it is still running when runShell returns unless runShell waited for it.
test('runShell: a helper that never starts and cannot be killed is reported, and does not keep ff waiting', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const res = await withEnv({ FF_TEST_STALL: '1' }, () => exec.runShell(`"${process.execPath}" -e "1"`, { timeoutMs: 800, taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] }));
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.cleanupErrors.length > 0, JSON.stringify(res));
    assert.ok(res.survivors.length === 1 && /not verified gone|could not be killed/.test(res.survivors[0].error), JSON.stringify(res.survivors));
    assert.ok(alive(res.survivors[0].pid), 'runShell waited for the stalled helper');
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
  }
});

test('runShell: an unreadable job membership is reported as unverified, never as a clean cleanup', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const pidFile = join(tmp, 'queryfail.pid');
  const p = script('queryfail.mjs', writesPid(pidFile));
  const { res } = await withEnv({ FF_TEST_QUERYFAIL: '1' }, () => timeOutWhen(`"${process.execPath}" "${p}"`, { timeoutMs: 3000 }, () => existsSync(pidFile)));
  assert.equal(res.timedOut, true);
  assert.ok(res.cleanupErrors.some((e) => /could not verify the job is empty/.test(e)), JSON.stringify(res.cleanupErrors));
  assert.ok(res.survivors.length > 0 && res.survivors.every((s) => /not verified gone/.test(s.error)), JSON.stringify(res.survivors));
  assert.match(res.output, /cleanup incomplete/);
});

test('runShell: job membership larger than the first query buffer is still listed in full', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async () => {
  const { pidFile, cmd } = orphanScripts('smallbuf');
  const { res } = await withEnv({ FF_TEST_BUF: '1' }, () => timeOutWhen(cmd, { timeoutMs: 3500, denyTerminate: true }, () => existsSync(pidFile)));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.length >= 3, JSON.stringify(res.survivors)); // shell, top, middle or grandchild: more than the 1-entry buffer
    assert.ok(res.survivors.some((s) => s.pid === pid), JSON.stringify(res.survivors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
    try { process.kill(pid); } catch {}
  }
});

test('runShell timeout leaves an unrelated orphan alone', CASE, async () => {
  const pidFile = join(tmp, 'unrelated.pid');
  const sleeper = script('unrelated-sleeper.mjs', writesPid(pidFile));
  const spawner = script('unrelated-spawner.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached: true, stdio: 'ignore' }).unref();`);
  await exec.run(process.execPath, [spawner]); // the sleeper's parent exits at once: an orphan unrelated to the shell below
  await waitFor(() => existsSync(pidFile)); // a sleeper that never starts fails at the case timeout
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    const hang = script('unrelated-hang.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
    const res = await exec.runShell(`"${process.execPath}" "${hang}"`, { timeoutMs: 800 });
    assert.equal(res.timedOut, true);
    assert.ok(alive(pid), 'unrelated orphan was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('run: failure message keeps the child stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', ...Array(1000).fill('argument')];
  await assert.rejects(exec.run(process.execPath, args), (e) => e.message.includes('BOOM-STDERR'));
});

test('run keeps complete error text and summarizes oversized argument tokens', async () => {
  const diagnostic = 'x'.repeat(3990) + '/private/worktree/secret-file';
  const argument = 'y'.repeat(290) + '/private/worktree/argument';
  await assert.rejects(exec.run(process.execPath, ['-e', 'process.stderr.write(process.argv[1]); process.exit(2)', diagnostic, argument]),
    (err) => err.message.includes(diagnostic) && err.message.includes(`<${argument.length} chars>`) && !err.message.includes(argument));
});

test('a long commit message does not displace a failing hook reason from the fenced error', async () => {
  const repo = join(tmp, 'hook-repo');
  await exec.run('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "Hook rejected: run lint first" >&2\nexit 1\n', { mode: 0o755 });
  const message = 'feat: Ticket\n\n' + 'Summary detail.\n'.repeat(230);
  await assert.rejects(exec.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=.git/hooks', 'commit', '--allow-empty', '-q', '-m', message], { cwd: repo }),
    (err) => {
      assert.ok(err.stderr.includes('Hook rejected: run lint first'), 'the hook ran');
      assert.ok(render.fence(err.message).includes('Hook rejected: run lint first'));
      return true;
    });
});

test('run never spawns through a shell', () => {
  assert.equal(typeof exec.run, 'function');
  assert.doesNotMatch(readFileSync(new URL('../lib/exec.mjs', import.meta.url), 'utf8'), /shell:\s*true/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
