import { spawn } from 'node:child_process';
import * as containment from './containment.ts';

// shortcut: no shell, so Windows needs real .exe binaries on PATH (the Agent CLIs, gh and git all ship them);
// npm .cmd shims would need cross-spawn.
export function run(cmd, args, { cwd, input, allowFail = false, inherit = false, timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = '',
      stderr = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.stdin.on('error', () => {}); // child exited before reading all input: 'close' reports it
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { code, stdout, stderr };
      if (code !== 0 && !allowFail) {
        const command = `${cmd} ${args.map((a) => (a.length > 200 ? `<${a.length} chars>` : a)).join(' ')} exited ${code}`;
        reject(Object.assign(new Error(`${(stderr || stdout).trim()}\n${command}`), res));
      } else resolve(res);
    });
  });
}

const POLL_GAP_MS = 250;

// Result of a helper process: { code, stdout, stderr }. Never rejects; code is null if it failed to start, outlived ms
// or was cancelled by signal. Without ms it is let finish, as taskkill /T must be: stopped partway on a loaded machine it
// can kill the shell but not the children it then no longer finds.
function quick(cmd, args, ms, env, signal) {
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '';
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    // let go of it as well as killing it: a helper that never exits would otherwise keep gg running through its handles
    const cancel = () => {
      p.kill('SIGKILL');
      p.unref();
      p.stdout.destroy();
      p.stderr.destroy();
      done(null);
    };
    const done = (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', cancel);
      resolve({ code, stdout, stderr });
    };
    const t =
      ms &&
      setTimeout(() => {
        p.kill();
        done(null);
      }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    p.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      stderr += e.message;
      done(null);
    });
    p.on('close', done);
  });
}

// { procs: [pid, ppid, started][], error } for every process; error is set when the snapshot is unusable.
// ps is let finish however long a loaded machine takes: a listing cut short names nothing. lstart is the start time the
// kernel recorded, so it is the same in every listing however late ps reads or answers; elapsed time read at an unknown
// moment of a slow listing would leave a window as long as the listing, wide enough for a reused pid.
async function snapshot(override, signal) {
  const [cmd, args] = override ?? ['ps', ['-e', '-o', 'pid=,ppid=,lstart=']]; // POSIX only; Windows uses a job object
  const r = await quick(cmd, args, undefined, { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, signal);
  const procs = r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((x) => x.length > 2 && /^\d+$/.test(x[0]) && /^\d+$/.test(x[1]))
    .map(([pid, ppid, ...started]) => [Number(pid), Number(ppid), started.join(' ')]);
  const error =
    r.code !== 0 || !procs.length
      ? `process snapshot failed (${r.code === null ? 'did not start' : 'exit ' + r.code}): ${r.stderr.trim()}`.trim()
      : undefined;
  return { procs, error };
}

const sameProc = (a, b) => a[0] === b[0] && a[2] === b[2];

// Descendants of rootPid seen so far and still running, keyed by pid with their start time, so they can still be
// recognised after their parent exits and they are reparented. Only processes positively linked to rootPid are recorded.
// stop() also cancels a listing in progress.
function watch(rootPid) {
  const seen = new Map();
  const cancel = new AbortController();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { procs, error } = await snapshot(undefined, cancel.signal);
      if (!error) {
        const listed = new Set(procs.map((p) => p[0]));
        for (const pid of seen.keys()) if (!listed.has(pid)) seen.delete(pid); // gone: its pid may come to name another process
        const mine = new Set([rootPid, ...seen.keys()]);
        for (let grew = true; grew;) {
          grew = false;
          for (const p of procs)
            if (!mine.has(p[0]) && mine.has(p[1]) && p[0] !== process.pid) {
              mine.add(p[0]);
              seen.set(p[0], p);
              grew = true;
            }
        }
      }
      await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
      cancel.abort();
      return loop;
    },
  };
}

// POSIX: kill the root and every descendant observed under it. Never touches other processes.
// Returns survivors ({ pid, error }) and cleanupErrors (strings) for anything that could not be confirmed gone.
// shortcut: a descendant that was reparented before a poll saw it is missed; upgrade to a cgroup (#128) for exact
// containment.
async function killTree(rootPid, seen, killPid, snapshotCommand) {
  const cleanupErrors = [];
  // Listed with the group stopped, before it is killed: no member can exit or start a process during the listing, so a
  // descendant detached from the group is still linked to its parent, not yet reparented.
  try {
    process.kill(-rootPid, 'SIGSTOP');
  } catch {} // the kill below reports a group it cannot signal
  const { procs, error } = await snapshot(snapshotCommand);
  try {
    process.kill(-rootPid, 'SIGKILL');
  } catch (e) {
    if (e.code !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${e.message}`);
  }
  const survivors = [];
  const tryKill = (pid) => {
    try {
      killPid(pid);
    } catch (e) {
      if (e.code !== 'ESRCH') survivors.push({ pid, error: e.message });
    }
  };
  if (error) {
    // cannot tell what is alive: attempt the root, and report every known descendant rather than claim success
    cleanupErrors.push(error);
    tryKill(rootPid);
    for (const pid of seen.keys())
      if (!survivors.some((s) => s.pid === pid)) survivors.push({ pid, error: 'not verified gone: ' + error });
    return { survivors, cleanupErrors };
  }
  const alive = new Set([rootPid]);
  for (const p of procs) if (seen.has(p[0]) && sameProc(seen.get(p[0]), p)) alive.add(p[0]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of procs)
      if (!alive.has(pid) && alive.has(ppid) && pid !== process.pid) {
        alive.add(pid);
        grew = true;
      }
  }
  for (const pid of alive) if (procs.some((p) => p[0] === pid)) tryKill(pid);
  // A listed pid with another start time is a new process under a reused pid, not ours to kill, or ours after a wall-clock
  // step moved every start time ps reports: left alone, and not claimed gone.
  for (const p of procs)
    if (seen.has(p[0]) && !alive.has(p[0]))
      survivors.push({ pid: p[0], error: 'not verified gone: its pid now has another start time' });
  return { survivors, cleanupErrors };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// What a timed-out command's output ends with: the timeout, each process left alive, and any cleanup that failed.
const timeoutNote = (timeoutMs, survivors, cleanupErrors) =>
  `\n[gg: timed out after ${timeoutMs} ms]` +
  survivors.map((s) => `\n[gg: could not kill pid ${s.pid}: ${s.error}]`).join('') +
  (cleanupErrors.length ? `\n[gg: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');

// Windows: terminate the job and wait until it is empty. A job not confirmed empty keeps gg's handle, so kill-on-close
// takes what is left when gg exits.
async function terminateJob(job, rootPid) {
  let refused;
  try {
    job.terminate();
  } catch (err) {
    refused = err.message;
  }
  const cleanupErrors = refused ? [refused] : [];
  try {
    if (refused) {
      const survivors = job.members().map((pid) => ({ pid, error: `termination refused: ${refused}` }));
      return { survivors, cleanupErrors };
    }
    await job.emptied();
    job.close();
    return { survivors: [], cleanupErrors };
  } catch (err) {
    cleanupErrors.push(`could not verify the job is empty: ${err.message}`);
    return { survivors: [{ pid: rootPid, error: 'not verified gone' }], cleanupErrors };
  }
}

// Windows without a job: taskkill /T takes down what is still linked to the shell; orphans cannot be found. The linked
// descendants are listed first, while the links exist, to be named if taskkill is refused. taskkill is let finish:
// stopped partway on a loaded machine it can kill the shell but not the children it then no longer finds. The
// taskkillCommand seam gets the pid as its last argument.
async function takeDownTree(rootPid, kernel32, taskkillCommand, containmentError) {
  const cleanupErrors = [containmentError];
  let linked = [];
  try {
    if (kernel32) linked = containment.linkedTo(kernel32, rootPid);
  } catch (err) {
    cleanupErrors.push(`could not list the command's descendants (${err.message}); they are not verified gone`);
  }
  const [command, args] = taskkillCommand ?? [`${containment.SYSTEM32}\\taskkill.exe`, ['/T', '/F', '/PID']];
  const r = await quick(command, [...args, String(rootPid)]);
  if (r.code === 0 || r.code === 128) return { survivors: [], cleanupErrors }; // 128: already gone
  cleanupErrors.push(`taskkill on command pid ${rootPid} failed: exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  const survivors = [rootPid, ...linked.filter(isAlive)].map((pid) => ({ pid, error: 'still running after cleanup' }));
  return { survivors, cleanupErrors };
}

// run and runShell over kernel32, the FFI bin/gg.mjs opens and passes down (ADR 0019); null runs Windows commands
// uncontained. Given nothing, it opens the real one.
export function createExec({ kernel32 = containment.openKernel32() } = {}) {
  return { run, runShell: (commandLine, options) => shell(kernel32, commandLine, options) };
}

// Run a repo-declared command line (e.g. "npm test") through the platform shell. timeoutMs bounds the command from the
// call, or from when testHooks.signal aborts.
// The result names its containment: job (Windows: the command and all it starts held in a job object) or none, with
// containmentError saying why when a Windows command runs uncontained. On timeout it resolves with timedOut: true,
// survivors: [{ pid, error }] for processes that could not be killed or confirmed gone, and cleanupErrors. A command
// that finishes but leaves processes behind is left alone and reported as leftovers: [pid] (job only; shortcut: POSIX
// does not report them).
// testHooks are a test's alone: snapshotCommand and taskkillCommand ([cmd, args]) replace the process listing / the tree
// kill, which gets the pid appended, and killPid the POSIX kill. With a signal, timeoutMs counts from when it aborts
// (from the call if it already has), so a case times the command out only once the processes it checks exist, however
// slowly they start. timers ({ setTimeout, clearTimeout }) run the timeout clock. onWatch gets the POSIX watcher's map
// of the descendants it has listed, keyed by pid, which it fills as it goes.
export const { runShell } = createExec();

function shell(kernel32, commandLine, { cwd, timeoutMs, testHooks = {} } = {}) {
  const {
    signal,
    killPid = (pid) => process.kill(pid, 'SIGKILL'),
    snapshotCommand,
    taskkillCommand,
    timers = globalThis,
    onWatch,
  } = testHooks;
  const { setTimeout, clearTimeout } = timers;
  const win = process.platform === 'win32';
  const { child, job, containmentError } = win
    ? containment.start(kernel32, commandLine, cwd)
    : {
        child: spawn('sh', ['-c', commandLine], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
        job: null,
      };
  const kind = job ? { containment: 'job' } : { containment: 'none', ...(containmentError && { containmentError }) };
  return new Promise((resolve, reject) => {
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.setEncoding('utf8').on('data', (d) => (out += d));
    const closed = new Promise((r) => child.on('close', r));
    let timedOut = false,
      finished = false,
      timer;
    const watcher = timeoutMs && !win ? watch(child.pid) : null;
    if (watcher) onWatch?.(watcher.seen);
    const onTimeout = async () => {
      timedOut = true; // the kill makes 'exit' and 'close' fire first; the timeout result below wins
      watcher?.stop();
      const { survivors, cleanupErrors } = job
        ? await terminateJob(job, child.pid)
        : win
          ? await takeDownTree(child.pid, kernel32, taskkillCommand, containmentError)
          : await killTree(child.pid, watcher?.seen, killPid, snapshotCommand);
      child.stdout.destroy();
      child.stderr.destroy(); // orphans may still hold the pipes
      const note = timeoutNote(timeoutMs, survivors, cleanupErrors);
      resolve({ code: null, output: out + note, timedOut: true, survivors, cleanupErrors, ...kind });
    };
    const arm = () => {
      if (!finished) timer = setTimeout(onTimeout, timeoutMs);
    };
    if (timeoutMs) {
      if (!signal || signal.aborted) arm();
      else signal.addEventListener('abort', arm, { once: true });
    }
    const end = () => {
      finished = true;
      clearTimeout(timer);
      watcher?.stop();
    };
    child.on('error', (e) => {
      end();
      reject(e);
    });
    if (!job) {
      child.on('close', (code) => {
        if (timedOut) return;
        end();
        resolve({ code, output: out, ...kind });
      });
      return;
    }
    // 'exit', not 'close': a leftover process can hold the pipes open for as long as it runs
    child.on('exit', async (code) => {
      if (timedOut) return;
      end();
      let leftovers = [];
      try {
        leftovers = job.leftovers(child.pid);
      } catch {} // an unreadable job names no leftovers, as a plain spawn names none
      job.release();
      // With no leftover every writer is gone, so the pipes close once read to the end.
      // shortcut: output a leftover holds unread at the exit is cut; #118 kills leftovers, and then the pipes close.
      await (leftovers.length ? new Promise((r) => setImmediate(r)) : closed);
      child.stdout.destroy();
      child.stderr.destroy();
      if (!leftovers.length) return resolve({ code, output: out, ...kind });
      const note = `\n[gg: command finished but left running: pid ${leftovers.join(', ')}]`;
      resolve({ code, output: out + note, leftovers, ...kind });
    });
  });
}
