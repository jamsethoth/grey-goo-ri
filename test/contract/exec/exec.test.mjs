import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../../../lib/exec.mjs';
import * as render from '../../../lib/render.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'ff-exec-'));
const script = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Waits for fn() to hold. A case that waits for an event that never comes fails at its own timeout, which aborts signal
// and so ends the wait, letting the case's cleanup run.
const waitFor = async (fn, signal) => {
  while (!fn()) {
    signal.throwIfAborted();
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Only a restricted sandbox may refuse cleanup; there survivors need only be reported.
const sandboxed = process.env.FF_TEST_SANDBOXED === '1';
// Cases that wait for a process event: a broken runShell fails at this bound instead of hanging the file.
const CASE = { timeout: 120_000 };
// How long a test process lives unless it is killed: longer than any case, so no command ends on its own first.
const LIVES_MS = 600_000;
const writesPid = (pidFile) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${LIVES_MS});`;

// Parent spawns a detached grandchild through an intermediate that writes midFile and lingers until goFile exists, then
// exits, leaving the grandchild orphaned while the parent outlives the timeout. delayMs holds the spawn back.
function orphanScripts(name, { delayMs = 0 } = {}) {
  const pidFile = join(tmp, `${name}.pid`), midFile = join(tmp, `${name}-mid.pid`), goFile = join(tmp, `${name}.go`);
  const grandchild = script(`${name}-gc.mjs`, writesPid(pidFile));
  const middle = script(`${name}-mid.mjs`, `import { spawn } from 'node:child_process'; import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(midFile)}, String(process.pid)); setTimeout(() => spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref(), ${delayMs}); const wait = setInterval(() => { if (existsSync(${JSON.stringify(goFile)})) clearInterval(wait); }, 50);`);
  const top = script(`${name}-top.mjs`, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: 'ignore' }); setTimeout(() => {}, ${LIVES_MS});`);
  return { pidFile, midFile, goFile, cmd: `"${process.execPath}" "${top}"` };
}

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
const pidIn = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

// Runs commandLine with its timeout clock held until ready() holds, so the processes a case checks exist before the
// timeout fires however slowly they start. ready is false when the command ended first.
// The case's own signal ends the wait too, and then the command is timed out before the case fails.
async function timeOutWhen(commandLine, options, ready, signal) {
  const clock = new AbortController();
  let settled = false;
  const running = exec.runShell(commandLine, { ...options, signal: clock.signal }).finally(() => { settled = true; });
  while (!settled && !ready() && !signal.aborted) await new Promise((r) => setTimeout(r, 50));
  const wasReady = ready();
  clock.abort();
  const res = await running;
  signal.throwIfAborted();
  return { res, ready: wasReady };
}

// A clock that never starts: the command runs in the job, and only its own end ends it.
const noClock = () => new AbortController().signal;

// runShell's timeout timer, moved by the case: tick(ms) moves the time on and fires the armed timer once it is due.
// fired() counts the timeouts that fired.
function manualTimers() {
  let now = 0;
  let armed = null;
  let fired = 0;
  return {
    setTimeout: (fn, ms) => (armed = { fn, at: now + ms }),
    clearTimeout: (timer) => { if (armed === timer) armed = null; },
    tick: (ms) => {
      now += ms;
      if (!armed || armed.at > now) return;
      const { fn } = armed;
      armed = null;
      fired++;
      fn();
    },
    fired: () => fired,
  };
}

// Holds back what a stream emits between hold() and release(), as a pipe read late on a loaded machine delivers it:
// listeners see the same events in the same order, only later.
function delayed(stream) {
  const emit = stream.emit;
  let held = null;
  stream.emit = function (event, ...args) {
    if (held && ['data', 'end', 'close'].includes(event)) { held.push([event, args]); return true; }
    return emit.call(this, event, ...args);
  };
  return {
    holding: () => held !== null,
    hold: () => { held ??= []; },
    release: () => { const events = held ?? []; held = null; for (const [event, args] of events) emit.call(stream, event, ...args); },
  };
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
  assert.equal(res.timedOut, undefined, res.output);
  assert.match(res.output, /eof/);
});

test('runShell with a timeout still returns the exit code and output of a command that finishes', CASE, async () => {
  const p = script('exit7.mjs', `console.log('hi'); process.exit(7);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 20000, signal: noClock() });
  assert.equal(res.code, 7);
  assert.match(res.output, /hi/);
  assert.equal(res.timedOut, undefined, res.output);
  assert.doesNotMatch(res.output, /FFJOB/);
  assert.equal(res.leftovers, undefined, 'a clean command must not report leftovers (e.g. its console host)');
});

// The budget is the case timeout: the command never ends on its own, so a runShell that waited for it could not pass.
test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', CASE, async () => {
  const p = script('sleep.mjs', `setInterval(() => {}, 60000);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
});

test('runShell: a timed-out command returns code null and the output it printed before the timeout', CASE, async (t) => {
  const printed = join(tmp, 'sentinel.printed');
  const p = script('sentinel.mjs', `import { writeFileSync } from 'node:fs'; console.log('SENTINEL-BEFORE-HANG'); writeFileSync(${JSON.stringify(printed)}, ''); setTimeout(() => {}, ${LIVES_MS});`);
  const { res } = await timeOutWhen(`"${process.execPath}" "${p}"`, { timeoutMs: 4000 }, () => existsSync(printed), t.signal);
  assert.equal(res.code, null);
  assert.equal(res.timedOut, true);
  assert.match(res.output, /SENTINEL-BEFORE-HANG/);
});

// Times out an orphan chain once runShell holds its grandchild (on POSIX, once its watcher has listed it; on Windows the
// job holds it from the start) and the middle has then exited, so the grandchild is an orphan however slowly the
// processes start and are listed. beforeClock runs just before the clock starts; options go to runShell. The grandchild
// is killed when the case ends.
async function timedOutOrphan(t, name, { delayMs, beforeClock, ...options } = {}) {
  const { pidFile, midFile, goFile, cmd } = orphanScripts(name, { delayMs });
  t.after(() => { try { if (pidIn(pidFile)) process.kill(pidIn(pidFile)); } catch {} });
  let seen = new Map();
  const ready = () => {
    const pid = pidIn(pidFile);
    if (!pid || (process.platform !== 'win32' && !seen.has(pid))) return false;
    writeFileSync(goFile, '');
    const mid = pidIn(midFile);
    if (!mid || alive(mid)) return false;
    beforeClock?.();
    return true;
  };
  const { res, ready: wasReady } = await timeOutWhen(cmd, { timeoutMs: 3500, ...options, onWatch: (s) => (seen = s) }, ready, t.signal);
  const pid = pidIn(pidFile);
  assert.ok(wasReady, `the chain ended before runShell held its grandchild ${pid} and the middle exited: ${res.output}`);
  return { res, pid };
}

const UNSANDBOXED_CASE = { ...CASE, skip: sandboxed && 'a restricted sandbox may refuse cleanup: see its own case' };
const SANDBOXED_CASE = { ...CASE, skip: !sandboxed && 'a restricted sandbox only' };

test('runShell timeout kills descendants by PID, including one whose parent already exited', UNSANDBOXED_CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'orphan');
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

test('in a restricted sandbox, runShell timeout kills descendants by PID or names each one it could not kill', SANDBOXED_CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'orphan-sandboxed');
  assert.equal(res.timedOut, true);
  // a descendant that is neither killed nor named with an error fails at the case timeout
  await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
});

test('runShell timeout kills a descendant that starts later than the timeout would have fired', UNSANDBOXED_CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'orphan-late', { delayMs: 4000 });
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

test('in a restricted sandbox, runShell timeout kills or names a descendant that starts later than the timeout would have fired', SANDBOXED_CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'orphan-late-sandboxed', { delayMs: 4000 });
  assert.equal(res.timedOut, true);
  // a descendant that is neither killed nor named with an error fails at the case timeout
  await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
});

test('runShell reports surviving PIDs and the kill error when termination fails', CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'refused', { killPid: () => { throw new Error('EPERM refused'); }, denyTerminate: true });
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.survivors.some((s) => s.pid === pid && /EPERM refused|withheld/.test(s.error)), JSON.stringify(res.survivors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {} // the withheld job leaves its root running too
  }
});

test('runShell with a failed process snapshot reports known descendants as unverified, not as cleaned up', { ...CASE, skip: process.platform === 'win32' && 'Windows contains descendants with a job object, no snapshot' }, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'nosnap', { killPid: () => { throw new Error('EPERM refused'); }, snapshotCommand: [process.execPath, ['-e', 'process.exit(1)']] });
  assert.equal(res.timedOut, true);
  assert.ok(res.survivors.some((s) => s.pid === pid), JSON.stringify(res.survivors));
  assert.ok(res.cleanupErrors.length > 0, JSON.stringify(res.cleanupErrors));
  assert.match(res.output, /cleanup incomplete/);
});

// Puts a stand-in ps running the sh body first on PATH until the case ends, at its timeout too, when the case's own code
// may still be running. In the body, PATH="${PATH#*:}" finds the real ps.
function psStandIn(t, name, body) {
  const dir = join(tmp, `${name}-bin`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => { process.env.PATH = path; });
}

const POSIX_CASE = { ...CASE, skip: (process.platform === 'win32' && 'POSIX process listing only') || (sandboxed && 'a restricted sandbox may refuse cleanup') };

// A loaded machine's listing: ps answers after the seconds in delayFile. Every listing outlasts the 1.5 s budget a
// listing once had, and the one at the timeout takes 3 s longer than the one that saw the grandchild, past the 2 s
// start-time tolerance once allowed. The sleep is the slow listing under test, not a wait of the case's.
test('runShell timeout kills an orphan its watcher listed, however slowly ps answers', POSIX_CASE, async (t) => {
  const delayFile = join(tmp, 'slow-ps.delay');
  writeFileSync(delayFile, '2');
  psStandIn(t, 'slow-ps', `sleep "$(cat '${delayFile}')"\nPATH="\${PATH#*:}" exec ps "$@"`);
  const { res, pid } = await timedOutOrphan(t, 'slow-ps', { beforeClock: () => writeFileSync(delayFile, '5') });
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

// At the timeout the grandchild's pid is listed with another start time, as when a new process has taken over the pid:
// the descendant the watcher listed is gone, and the process now under its pid is not the command's to kill.
test('runShell timeout leaves alone a process that took over the pid of a descendant it listed', POSIX_CASE, async (t) => {
  const pidFile = join(tmp, 'reused.pid'); // the grandchild's, as orphanScripts names it
  const listing = ['sh', ['-c', `ps -e -o pid=,ppid=,lstart= | awk -v gc="$(cat '${pidFile}')" '$1 == gc { print $1, $2, "Thu Jan  1 00:00:02 1970"; next } { print }'`]];
  const killed = [];
  const { res, pid } = await timedOutOrphan(t, 'reused', { snapshotCommand: listing, killPid: (p) => killed.push(p) });
  assert.equal(res.timedOut, true);
  assert.ok(!killed.includes(pid), `killed ${JSON.stringify(killed)}, the taken-over pid ${pid} among them`);
});

// The watcher's ps always fails, so only the listing at the timeout can find the grandchild, whose middle never exits
// here: a listing taken after the group kill would see it reparented, no longer linked to the command.
test('runShell timeout kills a detached descendant whose parent still runs, though the watcher never listed it', POSIX_CASE, async (t) => {
  const listing = ['sh', ['-c', `PATH="${process.env.PATH}" exec ps -e -o pid=,ppid=,lstart=`]];
  psStandIn(t, 'blind-ps', 'exit 1');
  const { pidFile, cmd } = orphanScripts('blind');
  t.after(() => { try { if (pidIn(pidFile)) process.kill(pidIn(pidFile)); } catch {} });
  const { res, ready } = await timeOutWhen(cmd, { timeoutMs: 3500, snapshotCommand: listing }, () => pidIn(pidFile) > 0, t.signal);
  const pid = pidIn(pidFile);
  assert.ok(ready, `grandchild never started: ${res.output}`);
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

test('runShell with a timeout leaves background processes of a command that finished on its own running', { ...CASE, skip: process.platform === 'win32' && 'Windows also reports them: see the next case' }, async (t) => {
  const pidFile = join(tmp, 'leftover.pid');
  const background = script('leftover-gc.mjs', writesPid(pidFile));
  const quit = script('leftover-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(background)}], { detached: true, stdio: 'ignore' }).unref();`);
  const res = await exec.runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 20000, signal: noClock() });
  assert.equal(res.code, 0);
  await waitFor(() => existsSync(pidFile), t.signal); // a background process that never starts fails at the case timeout
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(alive(pid), 'background process was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell with a timeout reports, and leaves running, the background processes of a command that finished on its own', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const pidFile = join(tmp, 'leftover-reported.pid');
  const background = script('leftover-reported-gc.mjs', writesPid(pidFile));
  const quit = script('leftover-reported-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(background)}], { detached: true, stdio: 'ignore' }).unref();`);
  const res = await exec.runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 20000, signal: noClock() });
  assert.equal(res.code, 0);
  await waitFor(() => existsSync(pidFile), t.signal); // a background process that never starts fails at the case timeout
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.leftovers?.includes(pid), JSON.stringify(res.leftovers));
    assert.match(res.output, /left running: pid/);
    assert.ok(alive(pid), 'background process was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell: a child that asks to break away from the job still starts, and is left outside the timeout kill', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
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
  const { res } = await timeOutWhen(`powershell.exe -NoProfile -NonInteractive -File "${ps}"`, { timeoutMs: 6000 }, () => existsSync(created), t.signal);
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

test('runShell: when the job cannot be set up, the timeout still takes down the process tree and says orphans are not contained', { ...CASE, skip: (process.platform !== 'win32' && 'Windows job objects only') || (sandboxed && 'a restricted sandbox may refuse cleanup: see its own case') }, async (t) => {
  const { pidFile, cmd } = linkedChild('nojob');
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000 }, () => existsSync(pidFile), t.signal));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.cleanupErrors.some((e) => /job object unavailable/.test(e)), JSON.stringify(res.cleanupErrors));
    assert.ok(pid, 'child never started');
    await waitFor(() => !alive(pid), t.signal); // a child still linked to the shell that is left running fails at the case timeout
  } finally {
    if (pid) try { process.kill(pid); } catch {}
  }
});

test('in a restricted sandbox, when the job cannot be set up, the timeout takes down or names the process tree and says orphans are not contained', { ...CASE, skip: (process.platform !== 'win32' && 'Windows job objects only') || (!sandboxed && 'a restricted sandbox only') }, async (t) => {
  const { pidFile, cmd } = linkedChild('nojob-sandboxed');
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000 }, () => existsSync(pidFile), t.signal));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(res.cleanupErrors.some((e) => /job object unavailable/.test(e)), JSON.stringify(res.cleanupErrors));
    assert.ok(pid, 'child never started');
    // a child still linked to the shell that is neither killed nor named with an error fails at the case timeout
    await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
  } finally {
    if (pid) try { process.kill(pid); } catch {}
  }
});

// A loaded machine can take seconds over taskkill /T. Stopped partway it may have killed the shell but not the children
// it can then no longer find, so a slow taskkill must be let finish, however slow: this one takes longer than the 30 s
// ceiling runShell once had. The seam gets the pid to kill as its last argument.
test('runShell: when the job cannot be set up, a slow taskkill still takes down the process tree', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const { pidFile, cmd } = linkedChild('nojob-slow');
  const slow = script('slow-taskkill.mjs', `import { spawnSync } from 'node:child_process'; setTimeout(() => process.exit(spawnSync('taskkill', ['/T', '/F', '/PID', String(process.argv[2])]).status ?? 1), 31000);`);
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, [slow]] }, () => existsSync(pidFile), t.signal));
  const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(pid, 'child never started');
    assert.ok(!res.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(res.cleanupErrors));
    await waitFor(() => !alive(pid), t.signal); // a child still linked to the shell that is left running fails at the case timeout
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
    if (pid) try { process.kill(pid); } catch {}
  }
});

test('runShell: when the job cannot be set up and taskkill is refused, the children still linked to the shell are named', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const { pidFile, cmd } = linkedChild('nojob-denied');
  const { res, ready } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] }, () => existsSync(pidFile), t.signal));
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

test('runShell: when the job cannot be set up and taskkill is refused, a child that starts later than the timeout would have fired is named', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const { pidFile, cmd } = linkedChild('nojob-late', { delayMs: 4500 });
  const { res } = await withEnv({ FF_TEST_NOJOB: '1' }, () => timeOutWhen(cmd, { timeoutMs: 4000, taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] }, () => existsSync(pidFile), t.signal));
  // taskkill is refused, so the top process lives on and starts the child even when the timeout came first
  await waitFor(() => existsSync(pidFile), t.signal);
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

// The timeout comes due just after runShell has seen the helper exit, while it still waits for the helper's notes (held
// back until then), and fires unless the exit stopped it. A timeout then would taskkill the helper's pid, which may by
// then be another process's. The leftover holds the output pipes, so they never close.
test('runShell: a command that finishes is not reported as timed out while its leftover process still holds the output pipes', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const sleeper = script('drain-sleeper.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
  const quit = script('drain-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached: true, stdio: 'inherit' }).unref();`);
  const timers = manualTimers();
  const onHelper = (helper) => {
    const late = [delayed(helper.stdout), delayed(helper.stderr)];
    for (const l of late) l.hold();
    // A microtask runs once every exit listener has, runShell's included.
    helper.on('exit', () => queueMicrotask(() => {
      timers.tick(1);
      for (const l of late) l.release();
    }));
  };
  // A timeout's kill of the helper's pid goes to a process that does nothing.
  const seam = [process.execPath, ['-e', '']];
  const res = await exec.runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 1, timers, taskkillCommand: seam, onHelper });
  try {
    assert.equal(res.timedOut, undefined, 'a finished command was reported as timed out');
    assert.equal(res.code, 0);
    assert.equal(timers.fired(), 0, 'a timeout ran after the command finished');
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
  const onHelper = (helper) => helper.stderr.on('data', (d) => { notes += d; if (notes.includes('\u0001FFJOB started')) seen(); });
  const timers = manualTimers();
  const running = exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 7000, timers, onHelper });
  timers.tick(6999);
  await started; // runShell's own listener ran right after this case's
  timers.tick(2);
  writeFileSync(go, '');
  const res = await running;
  assert.equal(res.timedOut, undefined, `the command timed out on the helper's start-up: ${res.output}`);
  assert.equal(res.code, 0);
  assert.match(res.output, /done/);
});

// The helper's last notes can reach runShell after its exit event, as on a loaded machine: here they are held back
// until the next turn of the event loop, after everything the exit set going has run. Its answer must still be read,
// never taken as a clean cleanup. The timeout fires as soon as runShell has seen the command start.
test('runShell: a helper answer that arrives after the helper has exited is still read', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const p = script('late-answer.mjs', writesPid(join(tmp, 'late-answer.pid')));
  const timers = manualTimers();
  const onHelper = (helper) => {
    const late = delayed(helper.stderr);
    let notes = '';
    helper.stderr.on('data', (d) => {
      notes += d;
      if (!notes.includes('\u0001FFJOB started') || late.holding()) return;
      late.hold();
      // A microtask runs once runShell's own listener has seen the start.
      queueMicrotask(() => timers.tick(1));
    });
    helper.on('exit', () => setImmediate(late.release));
  };
  const res = await withEnv({ FF_TEST_QUERYFAIL: '1' }, () => exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 1, timers, onHelper }));
  assert.ok(res.cleanupErrors.some((e) => /could not verify the job is empty/.test(e)), JSON.stringify(res.cleanupErrors));
  assert.ok(res.survivors.length > 0 && res.survivors.every((s) => /not verified gone/.test(s.error)), JSON.stringify(res.survivors));
});

// The helper's notes held back until 400 ms after it exits, past the 300 ms runShell once waited for them: a command
// that ran must not be taken for one the helper never started, and run a second time.
test('runShell: a finished command whose notes arrive after the helper has exited runs once', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const runs = join(tmp, 'once.runs');
  const p = script('once.mjs', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(runs)}, 'ran\\n');`);
  const onHelper = (helper) => {
    const late = delayed(helper.stderr);
    late.hold();
    helper.on('exit', () => setTimeout(late.release, 400));
  };
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 1, signal: noClock(), onHelper });
  assert.equal(readFileSync(runs, 'utf8'), 'ran\n', 'the command ran more than once');
  assert.equal(res.code, 0);
});

// With a signal aborted before the call, the clock counts from the call, as from any abort: the command's start does not
// restart it. The case moves runShell's clock itself.
test('runShell: a signal aborted before the call starts the timeout clock at the call', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const p = script('aborted-early.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
  let seen;
  const started = new Promise((r) => (seen = r));
  let notes = '';
  const onHelper = (helper) => helper.stderr.on('data', (d) => { notes += d; if (notes.includes('\u0001FFJOB started')) seen(); });
  const timers = manualTimers();
  const running = exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 7000, signal: AbortSignal.abort(), timers, onHelper });
  timers.tick(6999);
  await started; // runShell's own listener ran right after this case's
  timers.tick(2); // 7001 ms after the call
  const res = await running; // a clock restarted by the start never fires here: the case times out instead
  assert.equal(res.timedOut, true);
});

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

test('runShell: an unreadable job membership is reported as unverified, never as a clean cleanup', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const pidFile = join(tmp, 'queryfail.pid');
  const p = script('queryfail.mjs', writesPid(pidFile));
  const { res } = await withEnv({ FF_TEST_QUERYFAIL: '1' }, () => timeOutWhen(`"${process.execPath}" "${p}"`, { timeoutMs: 3000 }, () => existsSync(pidFile), t.signal));
  assert.equal(res.timedOut, true);
  assert.ok(res.cleanupErrors.some((e) => /could not verify the job is empty/.test(e)), JSON.stringify(res.cleanupErrors));
  assert.ok(res.survivors.length > 0 && res.survivors.every((s) => /not verified gone/.test(s.error)), JSON.stringify(res.survivors));
  assert.match(res.output, /cleanup incomplete/);
});

test('runShell: job membership larger than the first query buffer is still listed in full', { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' }, async (t) => {
  const { res, pid } = await withEnv({ FF_TEST_BUF: '1' }, () => timedOutOrphan(t, 'smallbuf', { denyTerminate: true }));
  try {
    assert.ok(res.survivors.length >= 3, JSON.stringify(res.survivors)); // shell, top and grandchild: more than the 1-entry buffer
    assert.ok(res.survivors.some((s) => s.pid === pid), JSON.stringify(res.survivors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {}
  }
});

test('runShell timeout leaves an unrelated orphan alone', CASE, async (t) => {
  const pidFile = join(tmp, 'unrelated.pid');
  const sleeper = script('unrelated-sleeper.mjs', writesPid(pidFile));
  const spawner = script('unrelated-spawner.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached: true, stdio: 'ignore' }).unref();`);
  await exec.run(process.execPath, [spawner]); // the sleeper's parent exits at once: an orphan unrelated to the shell below
  await waitFor(() => existsSync(pidFile), t.signal); // a sleeper that never starts fails at the case timeout
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

// A shell would split the argument at & and |.
test('run never spawns through a shell', async () => {
  const res = await exec.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a&b|c']);
  assert.equal(res.stdout, 'a&b|c');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
