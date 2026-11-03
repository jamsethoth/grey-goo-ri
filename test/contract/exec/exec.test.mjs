import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as containment from '../../../lib/containment.ts';
import * as exec from '../../../lib/exec.mjs';
import * as render from '../../../lib/render.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gg-exec-'));
// With args, the script reads them as `args` from a JSON file beside it, so no value the case passes becomes code.
const script = (name, body, args) => {
  const p = join(tmp, name);
  if (args) writeFileSync(`${p}.json`, JSON.stringify(args));
  writeFileSync(
    p,
    args
      ? `import { readFileSync as readArgs } from 'node:fs'; const args = JSON.parse(readArgs(process.argv[1] + '.json', 'utf8'));\n${body}`
      : body,
  );
  return p;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Waits for fn() to hold. A case that waits for an event that never comes fails at its own timeout, which aborts signal
// and so ends the wait, letting the case's cleanup run.
const waitFor = async (fn, signal) => {
  while (!fn()) {
    signal.throwIfAborted();
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Only a restricted sandbox may refuse cleanup; there survivors need only be reported.
const sandboxed = process.env.GG_TEST_SANDBOXED === '1';
// Cases that wait for a process event: a broken runShell fails at this bound instead of hanging the file.
const CASE = { timeout: 120_000 };
// How long a test process lives unless it is killed: longer than any case, so no command ends on its own first.
const LIVES_MS = 600_000;
// A script body for script(name, writesPid, [pidFile]).
const writesPid = `import { writeFileSync } from 'node:fs'; writeFileSync(args[0], String(process.pid)); setTimeout(() => {}, ${LIVES_MS});`;

// Parent spawns a detached grandchild through an intermediate that writes midFile and lingers until goFile exists, then
// exits, leaving the grandchild orphaned while the parent outlives the timeout. delayMs holds the spawn back.
function orphanScripts(name, { delayMs = 0 } = {}) {
  const pidFile = join(tmp, `${name}.pid`),
    midFile = join(tmp, `${name}-mid.pid`),
    goFile = join(tmp, `${name}.go`);
  const grandchild = script(`${name}-gc.mjs`, writesPid, [pidFile]);
  const middle = script(
    `${name}-mid.mjs`,
    `import { spawn } from 'node:child_process'; import { existsSync, writeFileSync } from 'node:fs'; const [midFile, grandchild, delayMs, goFile] = args; writeFileSync(midFile, String(process.pid)); setTimeout(() => spawn(process.execPath, [grandchild], { detached: true, stdio: 'ignore' }).unref(), delayMs); const wait = setInterval(() => { if (existsSync(goFile)) clearInterval(wait); }, 50);`,
    [midFile, grandchild, delayMs, goFile],
  );
  const top = script(
    `${name}-top.mjs`,
    `import { spawn } from 'node:child_process'; spawn(process.execPath, [args[0]], { stdio: 'ignore' }); setTimeout(() => {}, ${LIVES_MS});`,
    [middle],
  );
  return { pidFile, midFile, goFile, cmd: `"${process.execPath}" "${top}"` };
}

// The pid a script wrote to file, or 0 while it has not (yet) written it in full.
const pidIn = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

// Runs commandLine with its timeout clock held until ready() holds, so the processes a case checks exist before the
// timeout fires however slowly they start. ready is false when the command ended first.
// The case's own signal ends the wait too, and then the command is timed out before the case fails.
// options.kernel32, when given, is the FFI runShell runs on.
async function timeOutWhen(commandLine, { kernel32, ...options }, ready, signal) {
  const { runShell } = kernel32 === undefined ? exec : exec.createExec({ kernel32 });
  const clock = new AbortController();
  let settled = false,
    wasReady = false;
  const running = runShell(commandLine, shellOptions({ ...options, signal: clock.signal })).finally(() => {
    settled = true;
  });
  try {
    while (!settled && !signal.aborted && !ready()) await new Promise((r) => setTimeout(r, 50));
    wasReady = !signal.aborted && ready();
  } finally {
    // also when ready() throws, as it can once a failed case's files are gone: the command is timed out and cleaned up
    // before the case goes on, and the error ready() threw is the one the case reports
    clock.abort();
    await running.catch(() => {});
  }
  const res = await running;
  signal.throwIfAborted();
  return { res, ready: wasReady };
}

// The real kernel32 functions (null off Windows), and a copy with some replaced, as a job call that fails would answer.
const realKernel32 = containment.openKernel32();
const withKernel32 = (replaced) => ({ ...realKernel32, ...replaced });
// A kernel32 that cannot create a job, as when the job object is refused.
const noJob = () => withKernel32({ CreateJobObjectW: () => 0n });

// A clock that never starts: the command runs in the job, and only its own end ends it.
const noClock = () => new AbortController().signal;

// runShell's real inputs, and the rest of a case's options as its test hooks.
const shellOptions = ({ cwd, timeoutMs, ...testHooks } = {}) => ({ cwd, timeoutMs, testHooks });

// runShell's timeout timer, moved by the case: tick(ms) moves the time on and fires the armed timer once it is due.
// fired() counts the timeouts that fired.
function manualTimers() {
  let now = 0;
  let armed = null;
  let fired = 0;
  return {
    setTimeout: (fn, ms) => (armed = { fn, at: now + ms }),
    clearTimeout: (timer) => {
      if (armed === timer) armed = null;
    },
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

test('run: child that exits early while 5 MB of stdin is written resolves/rejects with its exit code', async () => {
  const input = 'x'.repeat(5 * 1024 * 1024);
  const args = ['-e', 'process.exit(3)'];
  const res = await exec.run(process.execPath, args, { input, allowFail: true });
  assert.equal(res.code, 3);
  await assert.rejects(exec.run(process.execPath, args, { input }), (e) => e.code === 3);
});

test('run and runShell read a multi-byte character split across chunks exactly', async () => {
  const p = script(
    'split.mjs',
    `process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 200);`,
  );
  assert.equal((await exec.run(process.execPath, [p])).stdout.trim(), '€');
  assert.equal((await exec.runShell(`"${process.execPath}" "${p}"`)).output.trim(), '€');
});

// Not timed out is the promptness check: a command left waiting on stdin would run until the case timeout. A wall-clock
// bound here measured the Windows job helper's cold start (8 to 15 s early in a loaded suite), so it was dropped, with
// the owner's approval, from this ported case.
test('runShell: a command waiting for stdin EOF returns promptly', CASE, async () => {
  const p = script('stdin.mjs', `process.stdin.resume(); process.stdin.on('end', () => console.log('eof'));`);
  const res = await exec.runShell(
    `"${process.execPath}" "${p}"`,
    shellOptions({ timeoutMs: 20000, signal: noClock() }),
  );
  assert.equal(res.timedOut, undefined, res.output);
  assert.match(res.output, /eof/);
});

test('runShell with a timeout still returns the exit code and output of a command that finishes', CASE, async () => {
  const p = script('exit7.mjs', `console.log('hi'); process.exit(7);`);
  const res = await exec.runShell(
    `"${process.execPath}" "${p}"`,
    shellOptions({ timeoutMs: 20000, signal: noClock() }),
  );
  assert.equal(res.code, 7);
  assert.match(res.output, /hi/);
  assert.equal(res.timedOut, undefined, res.output);
  assert.doesNotMatch(res.output, /GGJOB/);
  assert.equal(res.leftovers, undefined, 'a clean command must not report leftovers (e.g. its console host)');
});

// The budget is the case timeout: the command never ends on its own, so a runShell that waited for it could not pass.
test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', CASE, async () => {
  const p = script('sleep.mjs', `setInterval(() => {}, 60000);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.equal(res.timedOut, true);
});

test('a timeout note names gg', CASE, async () => {
  const p = script('sleep-note.mjs', `setInterval(() => {}, 60000);`);
  const res = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.match(res.output, /\n\[gg: timed out after 500 ms\]/);
  assert.doesNotMatch(res.output, /\[ff:/);
});

test(
  'runShell: a timed-out command returns code null and the output it printed before the timeout',
  CASE,
  async (t) => {
    const printed = join(tmp, 'sentinel.printed');
    const p = script(
      'sentinel.mjs',
      `import { writeFileSync } from 'node:fs'; console.log('SENTINEL-BEFORE-HANG'); writeFileSync(args[0], ''); setTimeout(() => {}, ${LIVES_MS});`,
      [printed],
    );
    const { res } = await timeOutWhen(
      `"${process.execPath}" "${p}"`,
      { timeoutMs: 4000 },
      () => existsSync(printed),
      t.signal,
    );
    assert.equal(res.code, null);
    assert.equal(res.timedOut, true);
    assert.match(res.output, /SENTINEL-BEFORE-HANG/);
  },
);

// Times out an orphan chain once runShell holds its grandchild (on POSIX, once its watcher has listed it; on Windows the
// job holds it from the start) and the middle has then exited, so the grandchild is an orphan however slowly the
// processes start and are listed. beforeClock runs just before the clock starts; options go to runShell. The grandchild
// is killed when the case ends.
async function timedOutOrphan(t, name, { delayMs, beforeClock, ...options } = {}) {
  const { pidFile, midFile, goFile, cmd } = orphanScripts(name, { delayMs });
  t.after(() => {
    try {
      if (pidIn(pidFile)) process.kill(pidIn(pidFile));
    } catch {}
  });
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
  const { res, ready: wasReady } = await timeOutWhen(
    cmd,
    { timeoutMs: 3500, ...options, onWatch: (s) => (seen = s) },
    ready,
    t.signal,
  );
  const pid = pidIn(pidFile);
  assert.ok(
    wasReady,
    `the chain ended before runShell held its grandchild ${pid} and the middle exited: ${res.output}`,
  );
  return { res, pid };
}

const UNSANDBOXED_CASE = { ...CASE, skip: sandboxed && 'a restricted sandbox may refuse cleanup: see its own case' };
const SANDBOXED_CASE = { ...CASE, skip: !sandboxed && 'a restricted sandbox only' };

test(
  'runShell timeout kills descendants by PID, including one whose parent already exited',
  UNSANDBOXED_CASE,
  async (t) => {
    const { res, pid } = await timedOutOrphan(t, 'orphan');
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.survivors, []);
    await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
  },
);

test(
  'in a restricted sandbox, runShell timeout kills descendants by PID or names each one it could not kill',
  SANDBOXED_CASE,
  async (t) => {
    const { res, pid } = await timedOutOrphan(t, 'orphan-sandboxed');
    assert.equal(res.timedOut, true);
    // a descendant that is neither killed nor named with an error fails at the case timeout
    await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
  },
);

test(
  'runShell timeout kills a descendant that starts later than the timeout would have fired',
  UNSANDBOXED_CASE,
  async (t) => {
    const { res, pid } = await timedOutOrphan(t, 'orphan-late', { delayMs: 4000 });
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.survivors, []);
    await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
  },
);

test(
  'in a restricted sandbox, runShell timeout kills or names a descendant that starts later than the timeout would have fired',
  SANDBOXED_CASE,
  async (t) => {
    const { res, pid } = await timedOutOrphan(t, 'orphan-late-sandboxed', { delayMs: 4000 });
    assert.equal(res.timedOut, true);
    // a descendant that is neither killed nor named with an error fails at the case timeout
    await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
  },
);

test('runShell reports surviving PIDs and the kill error when termination fails', CASE, async (t) => {
  const { res, pid } = await timedOutOrphan(t, 'refused', {
    killPid: () => {
      throw new Error('EPERM refused');
    },
    kernel32: withKernel32({ TerminateJobObject: () => 0 }),
  });
  try {
    assert.equal(res.timedOut, true);
    assert.ok(
      res.survivors.some((s) => s.pid === pid && /EPERM refused|termination refused/.test(s.error)),
      JSON.stringify(res.survivors),
    );
  } finally {
    for (const s of res.survivors)
      try {
        process.kill(s.pid);
      } catch {} // a refused termination leaves the shell running too
  }
});

test(
  'runShell with a failed process snapshot reports known descendants as unverified, not as cleaned up',
  { ...CASE, skip: process.platform === 'win32' && 'Windows contains descendants with a job object, no snapshot' },
  async (t) => {
    const { res, pid } = await timedOutOrphan(t, 'nosnap', {
      killPid: () => {
        throw new Error('EPERM refused');
      },
      snapshotCommand: [process.execPath, ['-e', 'process.exit(1)']],
    });
    assert.equal(res.timedOut, true);
    assert.ok(
      res.survivors.some((s) => s.pid === pid),
      JSON.stringify(res.survivors),
    );
    assert.ok(res.cleanupErrors.length > 0, JSON.stringify(res.cleanupErrors));
    assert.match(res.output, /cleanup incomplete/);
  },
);

// Sets environment variables for every process the case starts until the case ends, at its timeout too, when the case's
// own code may still be running. A script runShell starts takes no arguments from the case, so it reads its inputs here
// and none of them becomes code.
function caseEnv(t, vars) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}

// Puts a stand-in ps running the sh body first on PATH until the case ends. In the body, PATH="${PATH#*:}" finds the
// real ps.
function psStandIn(t, name, body) {
  const dir = join(tmp, `${name}-bin`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  caseEnv(t, { PATH: `${dir}:${process.env.PATH}` });
}

test("a case's environment variables are restored after the case even when it fails", async (t) => {
  caseEnv(t, { GG_TEST_ENV_PROBE: 'before' });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // The inner case times out while its body still runs, as a hung runShell case would.
  await t.test('a case that times out', { timeout: 50, todo: 'times out on purpose' }, (inner) => {
    caseEnv(inner, { GG_TEST_ENV_PROBE: 'during' });
    return held;
  });
  const after = process.env.GG_TEST_ENV_PROBE;
  release();
  assert.equal(after, 'before', 'the variable holds its value from before the case');
});

const POSIX_CASE = {
  ...CASE,
  skip:
    (process.platform === 'win32' && 'POSIX process listing only') ||
    (sandboxed && 'a restricted sandbox may refuse cleanup'),
};

// A loaded machine's listing: ps answers after the seconds in delayFile. Every listing outlasts the 1.5 s budget a
// listing once had, and the one at the timeout takes 3 s longer than the one that saw the grandchild, past the 2 s
// start-time tolerance once allowed. The sleep is the slow listing under test, not a wait of the case's.
test('runShell timeout kills an orphan its watcher listed, however slowly ps answers', POSIX_CASE, async (t) => {
  const delayFile = join(tmp, 'slow-ps.delay');
  writeFileSync(delayFile, '2');
  caseEnv(t, { GG_TEST_PS_DELAY: delayFile });
  psStandIn(t, 'slow-ps', `sleep "$(cat "$GG_TEST_PS_DELAY")" || exit 1\nPATH="\${PATH#*:}" exec ps "$@"`);
  const { res, pid } = await timedOutOrphan(t, 'slow-ps', { beforeClock: () => writeFileSync(delayFile, '5') });
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

// At the timeout the grandchild's pid is listed with another start time. A new process may have taken over the pid, and
// is not the command's to kill; or the wall clock was stepped, which moves every start time ps reports, and the
// descendant still runs. A listing cannot tell the two apart, so the descendant is named as not verified gone.
test(
  'runShell timeout leaves alone a pid listed with another start time, and names its descendant unverified',
  POSIX_CASE,
  async (t) => {
    const pidFile = join(tmp, 'reused.pid'); // the grandchild's, as orphanScripts names it
    const listing = [
      'sh',
      [
        '-c',
        `gc="$(cat "$1")" || exit 1; ps -e -o pid=,ppid=,lstart= | awk -v gc="$gc" '$1 == gc { print $1, $2, "Thu Jan  1 00:00:02 1970"; next } { print }'`,
        'sh',
        pidFile,
      ],
    ];
    const killed = [];
    const { res, pid } = await timedOutOrphan(t, 'reused', {
      snapshotCommand: listing,
      killPid: (p) => killed.push(p),
    });
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.cleanupErrors, []); // the listing was read, so the survivor below is not a failed listing's
    assert.ok(!killed.includes(pid), `killed ${JSON.stringify(killed)}, the taken-over pid ${pid} among them`);
    assert.ok(
      res.survivors.some((s) => s.pid === pid && /not verified gone/.test(s.error)),
      `grandchild ${pid} missing from ${JSON.stringify(res.survivors)}`,
    );
    assert.match(res.output, /could not kill pid/);
  },
);

// The chain's middle is listed, exits, and a later listing no longer has it; at the timeout the listing names a new
// process under its pid. A descendant the watcher saw exit is not the command's any more, so nothing is reported.
test(
  'runShell timeout does not name a descendant the watcher saw exit, though a new process now holds its pid',
  POSIX_CASE,
  async (t) => {
    const { pidFile, midFile, goFile, cmd } = orphanScripts('pruned');
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const listing = [
      'sh',
      [
        '-c',
        `mid="$(cat "$1")" || exit 1; ps -e -o pid=,ppid=,lstart= | awk -v mid="$mid" '{ print } END { print mid, 1, "Thu Jan  1 00:00:02 1970" }'`,
        'sh',
        midFile,
      ],
    ];
    let seen = new Map(),
      sawMiddle = false;
    const ready = () => {
      const mid = pidIn(midFile);
      sawMiddle ||= mid > 0 && seen.has(mid);
      if (!sawMiddle) return false;
      writeFileSync(goFile, '');
      return !alive(mid) && !seen.has(mid);
    };
    const { res, ready: wasReady } = await timeOutWhen(
      cmd,
      { timeoutMs: 3500, snapshotCommand: listing, onWatch: (s) => (seen = s) },
      ready,
      t.signal,
    );
    const mid = pidIn(midFile);
    assert.ok(wasReady, `the watcher never saw the middle ${mid} exit: ${res.output}`);
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.cleanupErrors, []);
    assert.ok(
      !res.survivors.some((s) => s.pid === mid),
      `middle ${mid}, seen to exit, named in ${JSON.stringify(res.survivors)}`,
    );
  },
);

// The watcher's ps never answers, and the command ends once that ps has started. runShell must let go of it, so the
// process that called runShell can exit, and kill it rather than leave it running. Its own child holds its output pipes
// open after it is killed, as a ps stalled in the kernel would: killing it alone does not let the caller go.
test(
  'runShell lets its caller exit when the command ends while the watcher is still listing',
  POSIX_CASE,
  async (t) => {
    const psPid = join(tmp, 'stalled-ps.pid'),
      holderPid = join(tmp, 'stalled-ps-holder.pid');
    // renamed into place, so the command never sees the file before the pids are in both
    caseEnv(t, { GG_TEST_PS_HOLDER: holderPid, GG_TEST_PS_PID: psPid });
    psStandIn(
      t,
      'stalled-ps',
      `sleep ${LIVES_MS / 1000} &\necho $! > "$GG_TEST_PS_HOLDER"\necho $$ > "$GG_TEST_PS_PID.tmp" && mv "$GG_TEST_PS_PID.tmp" "$GG_TEST_PS_PID"\nwait`,
    );
    t.after(() => {
      try {
        if (pidIn(holderPid)) process.kill(pidIn(holderPid));
      } catch {}
    });
    const quitPid = join(tmp, 'stalled-quit.pid');
    // it writes its pid so that a failed case can end it: it waits for the ps, and the caller's kill does not reach it
    const quit = script(
      'stalled-quit.mjs',
      `import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(args[1], String(process.pid)); const wait = setInterval(() => { if (existsSync(args[0])) clearInterval(wait); }, 50);`,
      [psPid, quitPid],
    );
    const caller = script(
      'stalled-caller.mjs',
      `const exec = await import(args[0]); const res = await exec.runShell(args[1], { timeoutMs: ${LIVES_MS} }); process.exitCode = res.code;`,
      [pathToFileURL(join(import.meta.dirname, '../../../lib/exec.mjs')).href, `"${process.execPath}" "${quit}"`],
    );
    const child = spawn(process.execPath, [caller], { stdio: ['ignore', 'ignore', 'inherit'] });
    t.after(() => {
      child.kill();
      for (const f of [psPid, quitPid])
        try {
          if (pidIn(f)) process.kill(pidIn(f));
        } catch {}
    });
    const [code] = await once(child, 'exit'); // a caller kept running by the listing fails at the case timeout
    assert.equal(code, 0);
    const pid = pidIn(psPid);
    assert.ok(pid > 0, `the stalled ps never wrote its pid to ${psPid}`);
    await waitFor(() => !alive(pid), t.signal); // a listing left running fails at the case timeout
  },
);

// The watcher's ps always fails, so only the listing at the timeout can find the grandchild, whose middle never exits
// here: a listing taken after the group kill would see it reparented, no longer linked to the command.
test(
  'runShell timeout kills a detached descendant whose parent still runs, though the watcher never listed it',
  POSIX_CASE,
  async (t) => {
    const listing = ['sh', ['-c', 'PATH="$1" exec ps -e -o pid=,ppid=,lstart=', 'sh', process.env.PATH]];
    psStandIn(t, 'blind-ps', 'exit 1');
    const { pidFile, cmd } = orphanScripts('blind');
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 3500, snapshotCommand: listing },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    const pid = pidIn(pidFile);
    assert.ok(ready, `grandchild never started: ${res.output}`);
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.survivors, []);
    await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
  },
);

test(
  'runShell with a timeout leaves background processes of a command that finished on its own running',
  { ...CASE, skip: process.platform === 'win32' && 'Windows also reports them: see the next case' },
  async (t) => {
    const pidFile = join(tmp, 'leftover.pid');
    const background = script('leftover-gc.mjs', writesPid, [pidFile]);
    const quit = script(
      'leftover-quit.mjs',
      `import { spawn } from 'node:child_process'; spawn(process.execPath, [args[0]], { detached: true, stdio: 'ignore' }).unref();`,
      [background],
    );
    const res = await exec.runShell(
      `"${process.execPath}" "${quit}"`,
      shellOptions({ timeoutMs: 20000, signal: noClock() }),
    );
    assert.equal(res.code, 0);
    await waitFor(() => existsSync(pidFile), t.signal); // a background process that never starts fails at the case timeout
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      assert.ok(alive(pid), 'background process was killed');
    } finally {
      try {
        process.kill(pid);
      } catch {}
    }
  },
);

test(
  'runShell with a timeout reports, and leaves running, the background processes of a command that finished on its own',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const pidFile = join(tmp, 'leftover-reported.pid');
    const background = script('leftover-reported-gc.mjs', writesPid, [pidFile]);
    const quit = script(
      'leftover-reported-quit.mjs',
      `import { spawn } from 'node:child_process'; spawn(process.execPath, [args[0]], { detached: true, stdio: 'ignore' }).unref();`,
      [background],
    );
    const res = await exec.runShell(
      `"${process.execPath}" "${quit}"`,
      shellOptions({ timeoutMs: 20000, signal: noClock() }),
    );
    assert.equal(res.code, 0);
    await waitFor(() => existsSync(pidFile), t.signal); // a background process that never starts fails at the case timeout
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      assert.ok(res.leftovers?.includes(pid), JSON.stringify(res.leftovers));
      assert.match(res.output, /left running: pid/);
      assert.ok(alive(pid), 'background process was killed');
    } finally {
      try {
        process.kill(pid);
      } catch {}
    }
  },
);

test(
  'runShell: a child that asks to break away from the job still starts, and is left outside the timeout kill',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const sleeper = script('ba-sleeper.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
    const created = join(tmp, 'breakaway.created');
    // CreateProcessW with CREATE_BREAKAWAY_FROM_JOB through node:ffi; STARTUPINFOW is 104 bytes on 64-bit Windows, and
    // PROCESS_INFORMATION's dwProcessId sits at byte 16.
    const breakaway = script(
      'breakaway.mjs',
      `import { writeFileSync } from 'node:fs';
const [exe, sleeper, created] = args;
const { functions: k } = process.getBuiltinModule('node:ffi').dlopen('kernel32.dll', {
  CreateProcessW: { arguments: ['pointer', 'buffer', 'pointer', 'pointer', 'int32', 'uint32', 'pointer', 'pointer', 'buffer', 'buffer'], return: 'int32' },
  GetLastError: { arguments: [], return: 'uint32' },
});
const startup = Buffer.alloc(104);
startup.writeUInt32LE(104, 0);
const info = Buffer.alloc(24);
const line = Buffer.from('"' + exe + '" "' + sleeper + '"\\0', 'utf16le');
const ok = k.CreateProcessW(0n, line, 0n, 0n, 0, 0x01000000, 0n, 0n, startup, info);
const r = ok ? 'created pid=' + info.readUInt32LE(16) : 'failed win32error=' + k.GetLastError();
console.log(r);
writeFileSync(created, r);
setTimeout(() => {}, ${LIVES_MS});`,
      [process.execPath, sleeper, created],
    );
    const { res } = await timeOutWhen(
      `"${process.execPath}" --disable-warning=ExperimentalWarning "${breakaway}"`,
      { timeoutMs: 6000 },
      () => existsSync(created),
      t.signal,
    );
    const m = res.output.match(/created pid=(\d+)/);
    const pid = m && Number(m[1]);
    try {
      assert.ok(m, `breakaway request was refused: ${res.output}`);
      assert.equal(res.timedOut, true);
      assert.ok(alive(pid), 'a child that broke away on purpose should be outside the job');
      assert.ok(!res.survivors.some((s) => s.pid === pid), 'an escaped child is not a survivor of the job');
    } finally {
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
  },
);

// A shell whose child writes pidFile; the child starts delayMs after the shell.
function linkedChild(name, { delayMs = 0 } = {}) {
  const pidFile = join(tmp, `${name}.pid`);
  const child = script(`${name}-child.mjs`, writesPid, [pidFile]);
  const top = script(
    `${name}-top.mjs`,
    `import { spawn } from 'node:child_process'; const [child, delayMs] = args; setTimeout(() => spawn(process.execPath, [child], { stdio: 'ignore' }), delayMs); setTimeout(() => {}, ${LIVES_MS});`,
    [child, delayMs],
  );
  return { pidFile, cmd: `"${process.execPath}" "${top}"` };
}

test(
  'runShell: when the job cannot be set up, the timeout still takes down the process tree and says orphans are not contained',
  {
    ...CASE,
    skip:
      (process.platform !== 'win32' && 'Windows job objects only') ||
      (sandboxed && 'a restricted sandbox may refuse cleanup: see its own case'),
  },
  async (t) => {
    const { pidFile, cmd } = linkedChild('nojob');
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob() },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
    try {
      assert.equal(res.timedOut, true);
      assert.ok(
        res.cleanupErrors.some((e) => /job object unavailable/.test(e)),
        JSON.stringify(res.cleanupErrors),
      );
      assert.ok(pid, 'child never started');
      await waitFor(() => !alive(pid), t.signal); // a child still linked to the shell that is left running fails at the case timeout
    } finally {
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
  },
);

test(
  'in a restricted sandbox, when the job cannot be set up, the timeout takes down or names the process tree and says orphans are not contained',
  {
    ...CASE,
    skip: (process.platform !== 'win32' && 'Windows job objects only') || (!sandboxed && 'a restricted sandbox only'),
  },
  async (t) => {
    const { pidFile, cmd } = linkedChild('nojob-sandboxed');
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob() },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
    try {
      assert.equal(res.timedOut, true);
      assert.ok(
        res.cleanupErrors.some((e) => /job object unavailable/.test(e)),
        JSON.stringify(res.cleanupErrors),
      );
      assert.ok(pid, 'child never started');
      // a child still linked to the shell that is neither killed nor named with an error fails at the case timeout
      await waitFor(() => !alive(pid) || res.survivors.some((s) => s.pid === pid && s.error), t.signal);
    } finally {
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
  },
);

// A loaded machine can take seconds over taskkill /T. Stopped partway it may have killed the shell but not the children
// it can then no longer find, so a slow taskkill must be let finish, however slow: this one takes longer than the 30 s
// ceiling runShell once had. The seam gets the pid to kill as its last argument.
test(
  'runShell: when the job cannot be set up, a slow taskkill still takes down the process tree',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const { pidFile, cmd } = linkedChild('nojob-slow');
    const slow = script(
      'slow-taskkill.mjs',
      `import { spawnSync } from 'node:child_process'; setTimeout(() => process.exit(spawnSync('taskkill', ['/T', '/F', '/PID', String(process.argv[2])]).status ?? 1), 31000);`,
    );
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob(), taskkillCommand: [process.execPath, [slow]] },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
    try {
      assert.equal(res.timedOut, true);
      assert.ok(pid, 'child never started');
      assert.ok(!res.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(res.cleanupErrors));
      await waitFor(() => !alive(pid), t.signal); // a child still linked to the shell that is left running fails at the case timeout
    } finally {
      for (const s of res.survivors)
        try {
          process.kill(s.pid);
        } catch {}
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
  },
);

test(
  'runShell: when the job cannot be set up and taskkill is refused, the children still linked to the shell are named',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const { pidFile, cmd } = linkedChild('nojob-denied');
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob(), taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] },
      () => existsSync(pidFile),
      t.signal,
    );
    const pid = ready ? Number(readFileSync(pidFile, 'utf8')) : null;
    try {
      assert.equal(res.timedOut, true);
      assert.ok(pid, 'child never started');
      assert.ok(
        res.survivors.some((s) => s.pid === pid),
        `linked child ${pid} missing from ${JSON.stringify(res.survivors)}`,
      );
      assert.ok(
        res.cleanupErrors.some((e) => /taskkill/.test(e)),
        JSON.stringify(res.cleanupErrors),
      );
    } finally {
      for (const s of res.survivors)
        try {
          process.kill(s.pid);
        } catch {}
      if (pid)
        try {
          process.kill(pid);
        } catch {}
    }
  },
);

test(
  'runShell: when the job cannot be set up and taskkill is refused, a child that starts later than the timeout would have fired is named',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const { pidFile, cmd } = linkedChild('nojob-late', { delayMs: 4500 });
    const { res } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob(), taskkillCommand: [process.execPath, ['-e', 'process.exit(1)']] },
      () => existsSync(pidFile),
      t.signal,
    );
    // taskkill is refused, so the top process lives on and starts the child even when the timeout came first
    await waitFor(() => existsSync(pidFile), t.signal);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(res.timedOut, true);
      assert.ok(
        res.survivors.some((s) => s.pid === pid),
        `linked child ${pid} missing from ${JSON.stringify(res.survivors)}`,
      );
      assert.ok(
        res.cleanupErrors.some((e) => /taskkill/.test(e)),
        JSON.stringify(res.cleanupErrors),
      );
    } finally {
      for (const s of res.survivors)
        try {
          process.kill(s.pid);
        } catch {}
      try {
        process.kill(pid);
      } catch {}
    }
  },
);

// The leftover holds the output pipes, so they never close: runShell answers once the command exits. Its clock moves
// only when the case moves it, which it never does, so the call cannot end by timing out.
test(
  'runShell: a command that finishes is not reported as timed out while its leftover process still holds the output pipes',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const pidFile = join(tmp, 'drain.pid');
    const sleeper = script('drain-sleeper.mjs', writesPid, [pidFile]);
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const quit = script(
      'drain-quit.mjs',
      `import { spawn } from 'node:child_process'; spawn(process.execPath, [args[0]], { detached: true, stdio: 'inherit' }).unref();`,
      [sleeper],
    );
    const timers = manualTimers();
    const res = await exec.runShell(`"${process.execPath}" "${quit}"`, shellOptions({ timeoutMs: 1, timers }));
    assert.equal(res.timedOut, undefined, 'a finished command was reported as timed out');
    assert.equal(res.code, 0);
    assert.equal(timers.fired(), 0, 'a timeout ran after the command finished');
  },
);

test(
  'runShell: an unreadable job membership is reported as unverified, never as a clean cleanup',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    const pidFile = join(tmp, 'queryfail.pid');
    const p = script('queryfail.mjs', writesPid, [pidFile]);
    const { res } = await timeOutWhen(
      `"${process.execPath}" "${p}"`,
      { timeoutMs: 3000, kernel32: withKernel32({ QueryInformationJobObject: () => 0 }) },
      () => existsSync(pidFile),
      t.signal,
    );
    assert.equal(res.timedOut, true);
    assert.ok(
      res.cleanupErrors.some((e) => /could not verify the job is empty/.test(e)),
      JSON.stringify(res.cleanupErrors),
    );
    assert.ok(
      res.survivors.length > 0 && res.survivors.every((s) => /not verified gone/.test(s.error)),
      JSON.stringify(res.survivors),
    );
    assert.match(res.output, /cleanup incomplete/);
  },
);

test(
  'runShell: job membership larger than the first query buffer is still listed in full',
  { ...CASE, skip: process.platform !== 'win32' && 'Windows job objects only' },
  async (t) => {
    // The job answers as one with more members than the first list holds: a query with room for fewer than 65 pids
    // fails with ERROR_MORE_DATA and says how many it holds, so only a list that grows past 64 entries is read.
    const MORE_DATA = 234;
    let refused = 0;
    let lastError = null;
    const kernel32 = withKernel32({
      TerminateJobObject: () => 0,
      GetLastError: () => lastError ?? realKernel32.GetLastError(),
      QueryInformationJobObject: (job, kind, buffer, length, returned) => {
        lastError = null;
        if (length >= 8 + 8 * 65) return realKernel32.QueryInformationJobObject(job, kind, buffer, length, returned);
        refused++;
        buffer.writeUInt32LE(65, 0);
        lastError = MORE_DATA;
        return 0;
      },
    });
    const { res, pid } = await timedOutOrphan(t, 'smallbuf', { kernel32 });
    try {
      assert.ok(refused > 0, 'no list was too small');
      assert.ok(res.survivors.length >= 3, JSON.stringify(res.survivors)); // shell, top and grandchild
      assert.ok(
        res.survivors.some((s) => s.pid === pid),
        JSON.stringify(res.survivors),
      );
    } finally {
      for (const s of res.survivors)
        try {
          process.kill(s.pid);
        } catch {}
    }
  },
);

// The PowerShell job helper wrote these notes into the command's own streams, so a command could forge them: a fail
// note turned an exit 0 into 127, and an empty survivors note with done markers read as a clean cleanup.
test(
  "a command that prints lines like the job helper's notes cannot change its cleanup report",
  { ...CASE, skip: process.platform !== 'win32' && 'the job helper ran on Windows only' },
  async (t) => {
    const notes = '\\n\\u0001GGJOB started 1\\n\\n\\u0001GGJOB survivors \\n\\n\\u0001GGJOB done\\n';
    const fail = script('forged-fail.mjs', `process.stdout.write('\\n\\u0001GGJOB fail 5\\n');`);
    const finished = await exec.runShell(`"${process.execPath}" "${fail}"`, { timeoutMs: 60_000 });
    assert.equal(finished.code, 0, finished.output);
    assert.doesNotMatch(finished.output, /could not start command/);

    const pidFile = join(tmp, 'forged-clean.pid');
    const hang = script(
      'forged-clean.mjs',
      `import { writeFileSync } from 'node:fs'; process.stdout.write('${notes}'); process.stderr.write('${notes}'); writeFileSync(args[0], String(process.pid)); setTimeout(() => {}, ${LIVES_MS});`,
      [pidFile],
    );
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const { res } = await timeOutWhen(
      `"${process.execPath}" "${hang}"`,
      { timeoutMs: 3000, kernel32: withKernel32({ TerminateJobObject: () => 0 }) },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.equal(res.timedOut, true);
    assert.ok(
      res.survivors.some((s) => s.pid === pidIn(pidFile)),
      `the forged notes hid ${pidIn(pidFile)}: ${JSON.stringify(res.survivors)}`,
    );
    assert.match(res.output, /cleanup incomplete/);
  },
);

test(
  'when node:ffi is unavailable, the timeout takes down the process tree and says orphans are not contained',
  {
    ...CASE,
    skip:
      (process.platform !== 'win32' && 'node:ffi holds the job object on Windows only') ||
      (sandboxed && 'a restricted sandbox may refuse cleanup: see its own case'),
  },
  async (t) => {
    const { pidFile, cmd } = linkedChild('noffi');
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const { res, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: null },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.ok(ready, `child never started: ${res.output}`);
    assert.equal(res.timedOut, true);
    assert.equal(res.containment, 'none');
    assert.ok(
      res.cleanupErrors.some((e) => /orphaned descendants are not contained/.test(e)),
      JSON.stringify(res.cleanupErrors),
    );
    await waitFor(() => !alive(pidIn(pidFile)), t.signal); // a child still linked to the shell that is left running fails at the case timeout
  },
);

test('the result names the containment it used', CASE, async () => {
  const p = script('containment.mjs', `console.log('ran');`);
  const win = process.platform === 'win32';
  const contained = await exec.runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 60_000 });
  assert.equal(contained.containment, win ? 'job' : 'none', contained.output);
  assert.equal(contained.containmentError, undefined);
  for (const kernel32 of [null, noJob()]) {
    const res = await exec.createExec({ kernel32 }).runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 60_000 });
    assert.equal(res.code, 0, res.output);
    assert.equal(res.containment, 'none');
    // a Windows call that runs uncontained says so whether or not it times out
    if (win) assert.match(res.containmentError ?? '', /orphaned descendants are not contained/);
  }
});

// cmd.exe reads a gate line before the command runs; an empty line would leave its error level at 1, which a bare
// `exit /b` or `if errorlevel` in the command reads.
test(
  'runShell: the command starts as in a fresh shell, with no error level and no gate variable',
  { ...CASE, skip: process.platform !== 'win32' && 'the stdin gate is Windows only' },
  async () => {
    const line =
      '(if errorlevel 1 (echo LEVEL1) else (echo LEVEL0)) & (if defined GG_GATE (echo DEFINED) else (echo UNDEFINED)) & exit /b';
    for (const runShell of [exec.runShell, exec.createExec({ kernel32: null }).runShell]) {
      const res = await runShell(line, { timeoutMs: 60_000 });
      assert.equal(res.code, 0, res.output);
      assert.match(res.output, /LEVEL0/);
      assert.match(res.output, /UNDEFINED/);
    }
  },
);

// bin/gg.mjs opens kernel32 and passes it down (ADR 0019); a module that imports exec must not open a second one.
// A query string loads a fresh copy of exec.mjs, so its import is seen here.
test(
  'importing exec opens no node:ffi, and its own runShell opens it on the first call',
  { ...CASE, skip: process.platform !== 'win32' && 'node:ffi is opened on Windows only' },
  async (t) => {
    const getBuiltinModule = process.getBuiltinModule;
    const opened = [];
    process.getBuiltinModule = (id) => {
      opened.push(id);
      return getBuiltinModule.call(process, id);
    };
    t.after(() => (process.getBuiltinModule = getBuiltinModule));
    const fresh = await import(`../../../lib/exec.mjs?import-${Date.now()}`);
    assert.deepEqual(opened, [], 'opened at import');
    const res = await fresh.runShell('echo ran', { timeoutMs: 60_000 });
    assert.equal(res.containment, 'job', res.output);
    assert.deepEqual(opened, ['node:ffi']);
  },
);

// The case moves runShell's clock itself, and never past the timeout: a clock that waited for an abort the signal had
// already given would never fire.
test('runShell: a signal aborted before the call starts the timeout clock at the call', CASE, async () => {
  const p = script('aborted-early.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
  const timers = manualTimers();
  const running = exec.runShell(
    `"${process.execPath}" "${p}"`,
    shellOptions({ timeoutMs: 7000, signal: AbortSignal.abort(), timers }),
  );
  timers.tick(7000);
  const res = await running;
  assert.equal(res.timedOut, true);
  assert.equal(timers.fired(), 1);
});

// libuv looks a bare program name up in the child's working directory before PATH unless gg's own environment sets
// NoDefaultCurrentDirectoryInExePath, so node.exe is planted there under the shell's and taskkill's names. taskkill
// starts in gg's working directory, so the case moves there too.
test(
  'runShell runs cmd.exe and taskkill.exe from System32, not copies planted in the working directory',
  {
    ...CASE,
    skip:
      (process.platform !== 'win32' && 'Windows only') ||
      (sandboxed && 'a restricted sandbox may refuse cleanup: see its own case'),
  },
  async (t) => {
    const planted = mkdtempSync(join(tmp, 'planted-'));
    for (const name of ['cmd.exe', 'taskkill.exe'])
      try {
        linkSync(process.execPath, join(planted, name));
      } catch {
        copyFileSync(process.execPath, join(planted, name)); // another volume
      }
    const noSearch = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const home = process.cwd();
    process.chdir(planted);
    t.after(() => {
      process.chdir(home);
      if (noSearch !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = noSearch;
    });
    const res = await exec.runShell('echo real', { cwd: planted, timeoutMs: 60_000 });
    assert.equal(res.code, 0, res.output);
    assert.match(res.output, /real/);

    const { pidFile, cmd } = linkedChild('planted');
    t.after(() => {
      try {
        if (pidIn(pidFile)) process.kill(pidIn(pidFile));
      } catch {}
    });
    const { res: timedOut, ready } = await timeOutWhen(
      cmd,
      { timeoutMs: 4000, kernel32: noJob() },
      () => pidIn(pidFile) > 0,
      t.signal,
    );
    assert.ok(ready, `child never started: ${timedOut.output}`);
    assert.ok(!timedOut.cleanupErrors.some((e) => /taskkill/.test(e)), JSON.stringify(timedOut.cleanupErrors));
    await waitFor(() => !alive(pidIn(pidFile)), t.signal); // a child taskkill never reached fails at the case timeout
  },
);

test('runShell timeout leaves an unrelated orphan alone', CASE, async (t) => {
  const pidFile = join(tmp, 'unrelated.pid');
  const sleeper = script('unrelated-sleeper.mjs', writesPid, [pidFile]);
  const spawner = script(
    'unrelated-spawner.mjs',
    `import { spawn } from 'node:child_process'; spawn(process.execPath, [args[0]], { detached: true, stdio: 'ignore' }).unref();`,
    [sleeper],
  );
  await exec.run(process.execPath, [spawner]); // the sleeper's parent exits at once: an orphan unrelated to the shell below
  await waitFor(() => existsSync(pidFile), t.signal); // a sleeper that never starts fails at the case timeout
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    const hang = script('unrelated-hang.mjs', `setTimeout(() => {}, ${LIVES_MS});`);
    const res = await exec.runShell(`"${process.execPath}" "${hang}"`, { timeoutMs: 800 });
    assert.equal(res.timedOut, true);
    assert.ok(alive(pid), 'unrelated orphan was killed');
  } finally {
    try {
      process.kill(pid);
    } catch {}
  }
});

test('run: failure message keeps the child stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', ...Array(1000).fill('argument')];
  await assert.rejects(exec.run(process.execPath, args), (e) => e.message.includes('BOOM-STDERR'));
});

test('run keeps complete error text and summarizes oversized argument tokens', async () => {
  const diagnostic = 'x'.repeat(3990) + '/private/worktree/secret-file';
  const argument = 'y'.repeat(290) + '/private/worktree/argument';
  await assert.rejects(
    exec.run(process.execPath, ['-e', 'process.stderr.write(process.argv[1]); process.exit(2)', diagnostic, argument]),
    (err) =>
      err.message.includes(diagnostic) &&
      err.message.includes(`<${argument.length} chars>`) &&
      !err.message.includes(argument),
  );
});

test('a long commit message does not displace a failing hook reason from the fenced error', async () => {
  const repo = join(tmp, 'hook-repo');
  await exec.run('git', ['init', '-q', repo]);
  writeFileSync(
    join(repo, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\necho "Hook rejected: run lint first" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const message = 'feat: Ticket\n\n' + 'Summary detail.\n'.repeat(230);
  await assert.rejects(
    exec.run(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'core.hooksPath=.git/hooks',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        message,
      ],
      { cwd: repo },
    ),
    (err) => {
      assert.ok(err.stderr.includes('Hook rejected: run lint first'), 'the hook ran');
      assert.ok(render.fence(err.message).includes('Hook rejected: run lint first'));
      return true;
    },
  );
});

// A shell would split the argument at & and |.
test('run never spawns through a shell', async () => {
  const res = await exec.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a&b|c']);
  assert.equal(res.stdout, 'a&b|c');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
