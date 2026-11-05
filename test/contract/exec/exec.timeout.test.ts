// lib/exec.ts's contract for a timed-out command's descendants: which are killed, and which are named as survivors.
// The POSIX cases run the watcher against stand-in listings of ps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as commandCleanup from '../../../lib/command-cleanup.ts';
import * as exec from '../../../lib/exec.ts';
import * as caseEnv from '../../support/case-env.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';
import * as timedOutShell from '../../support/timed-out-shell.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-exec-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { CASE, POSIX_CASE } = options;
const { alive, pidIn, waitFor } = processProbe;

test(
  'runShell timeout kills descendants by PID, including one whose parent already exited',
  options.UNSANDBOXED_CASE,
  async (t) => {
    const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'orphan');
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.survivors, []);
    await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
  },
);

test(
  'in a restricted sandbox, runShell timeout kills descendants by PID or names each one it could not kill',
  options.SANDBOXED_CASE,
  async (t) => {
    const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'orphan-sandboxed');
    assert.equal(result.timedOut, true);
    // a descendant that is neither killed nor named with an error fails at the case timeout
    await waitFor(
      () => !alive(pid) || result.survivors.some((survivor) => survivor.pid === pid && survivor.error),
      t.signal,
    );
  },
);

// The clock starts with the chain's grandchild running and its middle never told to exit.
test('an orphan case fails when its clock starts while the middle process still runs', CASE, async (t) => {
  const pidFile = join(scratch, 'middle-runs.pid'); // the grandchild's, as orphanChain names it
  await assert.rejects(
    timedOutShell.timedOutOrphan(t, scratch, 'middle-runs', { timeoutMs: 1, ready: () => pidIn(pidFile) > 0 }),
    /before the middle \d+ exited/,
  );
});

// The watcher's ps always fails, so the middle exits with the grandchild never listed.
test(
  'an orphan case fails when its clock starts before the watcher has listed the grandchild',
  POSIX_CASE,
  async (t) => {
    caseEnv.psStandIn(t, scratch, 'unlisted-ps', 'exit 1');
    // as orphanChain names them
    const [pidFile, midFile, goFile] = ['unlisted.pid', 'unlisted-mid.pid', 'unlisted.go'].map((name) =>
      join(scratch, name),
    );
    const ready = () => {
      if (pidIn(pidFile) > 0) writeFileSync(goFile, '');
      return pidIn(midFile) > 0 && !alive(pidIn(midFile));
    };
    await assert.rejects(
      timedOutShell.timedOutOrphan(t, scratch, 'unlisted', { timeoutMs: 1, ready }),
      /before runShell held the grandchild \d+/,
    );
  },
);

// The case ends with the grandchild running and its pid not yet in the file the chain's cleanup reads, here a file it
// never writes, and the watcher's ps always fails. Only the listing at the timeout can find it, through its parent, so
// the case's end must leave the parent to that listing.
test(
  'a case that ends before its grandchild writes its pid does not leave that grandchild running',
  POSIX_CASE,
  async (t) => {
    const listing: [string, string[]] = [
      'sh',
      ['-c', 'PATH="$1" exec ps -e -o pid=,ppid=,lstart=', 'sh', process.env.PATH ?? ''],
    ];
    caseEnv.psStandIn(t, scratch, 'unwritten-ps', 'exit 1');
    const grandchildPid = join(scratch, 'unwritten-grandchild.pid');
    t.after(() => processProbe.endProcessIn(grandchildPid));
    const cancel = new AbortController();
    const cancelled = t.test(
      'a case that is cancelled',
      { signal: cancel.signal, todo: 'cancelled on purpose' },
      async (inner) => {
        const { midFile, goFile } = childScripts.orphanChain(inner, scratch, 'unwritten');
        await timedOutShell.timeOutWhen(
          childScripts.nodeCommand(
            inner,
            childScripts.CHILD_STARTER,
            childScripts.ORPHAN_MIDDLE,
            midFile,
            goFile,
            childScripts.LONG_LIVED,
            grandchildPid,
          ),
          { timeoutMs: 1, snapshotCommand: listing },
          () => false,
          inner,
        );
      },
    );
    await waitFor(() => pidIn(grandchildPid) > 0, t.signal);
    const pid = pidIn(grandchildPid);
    cancel.abort();
    await cancelled;
    await waitFor(() => !alive(pid), t.signal); // a grandchild left running fails at the case timeout
  },
);

test('runShell reports surviving PIDs and the kill error when termination fails', CASE, async (t) => {
  const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'refused', {
    killPid: () => {
      throw new Error('EPERM refused');
    },
    kernel32: kernel32Doubles.withKernel32({ TerminateJobObject: () => 0 }),
  });
  assert.equal(result.timedOut, true);
  assert.ok(
    result.survivors.some(
      (survivor) => survivor.pid === pid && /EPERM refused|termination refused/.test(survivor.error),
    ),
    JSON.stringify(result.survivors),
  );
});

test(
  'runShell with a failed process snapshot reports known descendants as unverified, not as cleaned up',
  { ...CASE, skip: process.platform === 'win32' && 'Windows contains descendants with a job object, no snapshot' },
  async (t) => {
    const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'nosnap', {
      killPid: () => {
        throw new Error('EPERM refused');
      },
      snapshotCommand: [process.execPath, ['-e', 'process.exit(1)']],
    });
    assert.equal(result.timedOut, true);
    assert.ok(
      result.survivors.some((survivor) => survivor.pid === pid),
      JSON.stringify(result.survivors),
    );
    assert.ok(result.cleanupErrors.length > 0, JSON.stringify(result.cleanupErrors));
    assert.match(result.output, /cleanup incomplete/);
  },
);

// A loaded machine's listing: ps answers after the seconds in delayFile. Every listing outlasts the 1.5 s budget a
// listing once had, and the one at the timeout takes 3 s longer than the one that saw the grandchild, past the 2 s
// start-time tolerance once allowed. The sleep is the slow listing under test, not a wait of the case's.
test('runShell timeout kills an orphan its watcher listed, however slowly ps answers', POSIX_CASE, async (t) => {
  const delayFile = join(scratch, 'slow-ps.delay');
  writeFileSync(delayFile, '2');
  caseEnv.caseEnv(t, { GG_TEST_PS_DELAY: delayFile });
  caseEnv.psStandIn(
    t,
    scratch,
    'slow-ps',
    `sleep "$(cat "$GG_TEST_PS_DELAY")" || exit 1\nPATH="\${PATH#*:}" exec ps "$@"`,
  );
  const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'slow-ps', {
    beforeClock: () => writeFileSync(delayFile, '5'),
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.survivors, []);
  await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
});

// At the timeout the grandchild's pid is listed with another start time. A new process may have taken over the pid,
// and is not the command's to kill; or the wall clock was stepped, which moves every start time ps reports, and the
// descendant still runs. A listing cannot tell the two apart, so the descendant is named as not verified gone.
test(
  'runShell timeout leaves alone a pid listed with another start time, and names its descendant unverified',
  POSIX_CASE,
  async (t) => {
    const pidFile = join(scratch, 'reused.pid'); // the grandchild's, as orphanChain names it
    const rewrite = `$1 == gc { print $1, $2, "Thu Jan  1 00:00:02 1970"; next } { print }`;
    const listing: [string, string[]] = [
      'sh',
      ['-c', `gc="$(cat "$1")" || exit 1; ps -e -o pid=,ppid=,lstart= | awk -v gc="$gc" '${rewrite}'`, 'sh', pidFile],
    ];
    const killed: number[] = [];
    const { result, pid } = await timedOutShell.timedOutOrphan(t, scratch, 'reused', {
      snapshotCommand: listing,
      killPid: (killedPid) => killed.push(killedPid),
    });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.cleanupErrors, []); // the listing was read, so the survivor below is not a failed listing's
    assert.ok(!killed.includes(pid), `killed ${JSON.stringify(killed)}, the taken-over pid ${pid} among them`);
    assert.ok(
      result.survivors.some((survivor) => survivor.pid === pid && /not verified gone/.test(survivor.error)),
      `grandchild ${pid} missing from ${JSON.stringify(result.survivors)}`,
    );
    assert.match(result.output, /could not kill pid/);
  },
);

// The chain's middle is listed, exits, and a later listing no longer has it; at the timeout the listing names a new
// process under its pid. A descendant the watcher saw exit is not the command's any more, so nothing is reported.
test(
  'runShell timeout does not name a descendant the watcher saw exit, though a new process now holds its pid',
  POSIX_CASE,
  async (t) => {
    const { pidFile, midFile, goFile, commandLine, middleExited } = childScripts.orphanChain(t, scratch, 'pruned');
    const append = `{ print } END { print mid, 1, "Thu Jan  1 00:00:02 1970" }`;
    const listing: [string, string[]] = [
      'sh',
      ['-c', `mid="$(cat "$1")" || exit 1; ps -e -o pid=,ppid=,lstart= | awk -v mid="$mid" '${append}'`, 'sh', midFile],
    ];
    let seen: commandCleanup.Seen = new Map();
    let sawMiddle = false;
    const ready = () => {
      const mid = pidIn(midFile);
      sawMiddle ||= mid > 0 && seen.has(mid);
      // the middle stays until the grandchild's pid is known: unlisted, that pid is all that can end it afterwards
      if (!sawMiddle || !pidIn(pidFile)) return false;
      writeFileSync(goFile, '');
      return middleExited() && !seen.has(mid);
    };
    const { result } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 3500, snapshotCommand: listing, onWatch: (watched) => (seen = watched) },
      ready,
      t,
    );
    const mid = pidIn(midFile);
    assert.ok(sawMiddle && !seen.has(mid), `the watcher never saw the middle ${mid} exit: ${result.output}`);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.cleanupErrors, []);
    assert.ok(
      !result.survivors.some((survivor) => survivor.pid === mid),
      `middle ${mid}, seen to exit, named in ${JSON.stringify(result.survivors)}`,
    );
  },
);

// The watcher's ps never answers, and the command ends once that ps has started. runShell must let go of it, so the
// process that called runShell can exit, and kill it rather than leave it running. Its own child holds its output
// pipes open after it is killed, as a ps stalled in the kernel would: killing it alone does not let the caller go.
test(
  'runShell lets its caller exit when the command ends while the watcher is still listing',
  POSIX_CASE,
  async (t) => {
    const psPid = join(scratch, 'stalled-ps.pid');
    const holderPid = join(scratch, 'stalled-ps-holder.pid');
    // renamed into place, so the command never sees the file before the pids are in both
    caseEnv.caseEnv(t, { GG_TEST_PS_HOLDER: holderPid, GG_TEST_PS_PID: psPid });
    caseEnv.psStandIn(
      t,
      scratch,
      'stalled-ps',
      `sleep ${childScripts.LIVES_MS / 1000} &\necho $! > "$GG_TEST_PS_HOLDER"\n` +
        `echo $$ > "$GG_TEST_PS_PID.tmp" && mv "$GG_TEST_PS_PID.tmp" "$GG_TEST_PS_PID"\nwait`,
    );
    t.after(() => processProbe.endProcessIn(holderPid));
    // it writes its pid so that a failed case can end it: it waits for the ps, and the caller's kill does not reach it
    const quitPid = join(scratch, 'stalled-quit.pid');
    const quit = childScripts.nodeCommand(t, childScripts.WAITS_FOR_FILE, psPid, quitPid);
    const child = spawn(process.execPath, [childScripts.SHELL_CALLER, quit], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    t.after(() => {
      child.kill();
      for (const file of [psPid, quitPid]) processProbe.endProcessIn(file);
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
    const listing: [string, string[]] = [
      'sh',
      ['-c', 'PATH="$1" exec ps -e -o pid=,ppid=,lstart=', 'sh', process.env.PATH ?? ''],
    ];
    caseEnv.psStandIn(t, scratch, 'blind-ps', 'exit 1');
    const { pidFile, commandLine } = childScripts.orphanChain(t, scratch, 'blind');
    const { result, ready } = await timedOutShell.timeOutWhen(
      commandLine,
      { timeoutMs: 3500, snapshotCommand: listing },
      () => pidIn(pidFile) > 0,
      t,
    );
    const pid = pidIn(pidFile);
    assert.ok(ready, `grandchild never started: ${result.output}`);
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.survivors, []);
    await waitFor(() => !alive(pid), t.signal); // a descendant that is never killed fails at the case timeout
  },
);

test('runShell timeout leaves an unrelated orphan alone', CASE, async (t) => {
  const pidFile = join(scratch, 'unrelated.pid');
  // the sleeper's parent exits once it has started: an orphan unrelated to the shell below
  await exec.run(process.execPath, [childScripts.DETACHED_CHILD, 'ignore', pidFile]);
  await waitFor(() => existsSync(pidFile), t.signal); // a sleeper that never starts fails at the case timeout
  const pid = pidIn(pidFile);
  try {
    const result = await exec.runShell(
      childScripts.nodeCommand(t, childScripts.LONG_LIVED, join(scratch, 'unrelated-hang.pid')),
      {
        timeoutMs: 800,
      },
    );
    assert.equal(result.timedOut, true);
    assert.ok(alive(pid), 'unrelated orphan was killed');
  } finally {
    processProbe.endProcess(pid);
  }
});
