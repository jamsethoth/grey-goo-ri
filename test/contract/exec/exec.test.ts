// lib/exec.ts's contract on every platform: run, and runShell with the commands that finish or time out on their own.
// The descendants a timeout kills are in exec.timeout.test.ts, and the Windows job object in exec.job.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../../../lib/exec.ts';
import * as render from '../../../lib/render.ts';
import * as caseEnv from '../../support/case-env.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as manualTimers from '../../support/manual-timers.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';
import * as timedOutShell from '../../support/timed-out-shell.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-exec-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { CASE } = options;
const { nodeCommand } = childScripts;
const { noClock, shellOptions } = timedOutShell;

test('run: child that exits early while 5 MB of stdin is written resolves/rejects with its exit code', async () => {
  const input = 'x'.repeat(5 * 1024 * 1024);
  const args = ['-e', 'process.exit(3)'];
  const result = await exec.run(process.execPath, args, { input, allowFail: true });
  assert.equal(result.code, 3);
  await assert.rejects(exec.run(process.execPath, args, { input }), (err: exec.CommandError) => err.code === 3);
});

test('run and runShell read a multi-byte character split across chunks exactly', async (t) => {
  assert.equal((await exec.run(process.execPath, [childScripts.SPLIT_CHARACTER, '200'])).stdout.trim(), '€');
  assert.equal((await exec.runShell(nodeCommand(t, childScripts.SPLIT_CHARACTER, '200'))).output.trim(), '€');
});

// Not timed out is the promptness check: a command left waiting on stdin would run until the case timeout. A
// wall-clock bound here measured the Windows job helper's cold start (8 to 15 s early in a loaded suite), so it was
// dropped, with the owner's approval, from this ported case.
test('runShell: a command waiting for stdin EOF returns promptly', CASE, async (t) => {
  const result = await exec.runShell(
    nodeCommand(t, childScripts.STDIN_EOF, 'eof'),
    shellOptions({ timeoutMs: 20000, signal: noClock() }),
  );
  assert.equal(result.timedOut, undefined, result.output);
  assert.match(result.output, /eof/);
});

test('runShell with a timeout still returns the exit code and output of a command that finishes', CASE, async (t) => {
  const result = await exec.runShell(
    nodeCommand(t, childScripts.PRINTS_LINE, 'hi', '7'),
    shellOptions({ timeoutMs: 20000, signal: noClock() }),
  );
  assert.equal(result.code, 7);
  assert.match(result.output, /hi/);
  assert.equal(result.timedOut, undefined, result.output);
  assert.doesNotMatch(result.output, /GGJOB/);
  assert.equal(result.leftovers, undefined, 'a clean command must not report leftovers (e.g. its console host)');
});

// The budget is the case timeout: the command never ends on its own, so a runShell that waited for it could not pass.
test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', CASE, async (t) => {
  const result = await exec.runShell(nodeCommand(t, childScripts.LONG_LIVED, join(scratch, 'sleep.pid')), {
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
});

test('a timeout note names gg', CASE, async (t) => {
  const result = await exec.runShell(nodeCommand(t, childScripts.LONG_LIVED, join(scratch, 'sleep-note.pid')), {
    timeoutMs: 500,
  });
  assert.match(result.output, /\n\[gg: timed out after 500 ms\]/);
  assert.doesNotMatch(result.output, /\[ff:/);
});

test(
  'runShell: a timed-out command returns code null and the output it printed before the timeout',
  CASE,
  async (t) => {
    const printed = join(scratch, 'sentinel.printed');
    const { result } = await timedOutShell.timeOutWhen(
      nodeCommand(t, childScripts.LONG_LIVED, printed, 'SENTINEL-BEFORE-HANG'),
      { timeoutMs: 4000 },
      () => existsSync(printed),
      t,
    );
    assert.equal(result.code, null);
    assert.equal(result.timedOut, true);
    assert.match(result.output, /SENTINEL-BEFORE-HANG/);
  },
);

// process.kill(0, 0) signals the caller's own group, so a pid never written would read as a running process.
test('checking a process whose pid was never written fails the case', () => {
  assert.throws(() => processProbe.alive(0), /no process to check: the pid is 0/);
  assert.throws(() => processProbe.alive(NaN), /no process to check: the pid is NaN/);
});

test("a case's environment variables are restored after the case even when it fails", async (t) => {
  caseEnv.caseEnv(t, { GG_TEST_ENV_PROBE: 'before' });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  // The inner case times out while its body still runs, as a hung runShell case would.
  await t.test('a case that times out', { timeout: 50, todo: 'times out on purpose' }, (inner) => {
    caseEnv.caseEnv(inner, { GG_TEST_ENV_PROBE: 'during' });
    return held;
  });
  const after = process.env.GG_TEST_ENV_PROBE;
  release();
  assert.equal(after, 'before', 'the variable holds its value from before the case');
});

test(
  'runShell with a timeout leaves background processes of a command that finished on its own running',
  { ...CASE, skip: process.platform === 'win32' && 'Windows also reports them: see exec.job.test.ts' },
  async (t) => {
    const pidFile = join(scratch, 'leftover.pid');
    t.after(() => processProbe.endProcessIn(pidFile));
    const result = await exec.runShell(
      nodeCommand(t, childScripts.DETACHED_CHILD, 'ignore', pidFile),
      shellOptions({ timeoutMs: 20000, signal: noClock() }),
    );
    assert.equal(result.code, 0);
    assert.ok(processProbe.alive(processProbe.pidIn(pidFile)), 'background process was killed');
  },
);

test('the result names the containment it used', CASE, async (t) => {
  // built before each run, so a run after the case's timeout stops at nodeCommand's abort check
  const command = () => nodeCommand(t, childScripts.PRINTS_LINE, 'ran');
  const win = process.platform === 'win32';
  const contained: exec.ShellResult & { containmentError?: string } = await exec.runShell(command(), {
    timeoutMs: 60_000,
  });
  assert.equal(contained.containment, win ? 'job' : 'none', contained.output);
  assert.equal(contained.containmentError, undefined);
  for (const kernel32 of [null, kernel32Doubles.noJob()]) {
    const result = await exec.createExec({ kernel32 }).runShell(command(), { timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.containment, 'none');
    // a Windows call that runs uncontained says so whether or not it times out
    if (win) assert.match(result.containmentError ?? '', /orphaned descendants are not contained/);
  }
});

// The case moves runShell's clock itself, and never past the timeout: a clock that waited for an abort the signal had
// already given would never fire.
test('runShell: a signal aborted before the call starts the timeout clock at the call', CASE, async (t) => {
  const timers = manualTimers.manualTimers();
  const running = exec.runShell(
    nodeCommand(t, childScripts.LONG_LIVED, join(scratch, 'aborted-early.pid')),
    shellOptions({ timeoutMs: 7000, signal: AbortSignal.abort(), timers }),
  );
  timers.tick(7000);
  const result = await running;
  assert.equal(result.timedOut, true);
  assert.equal(timers.fired(), 1);
});

test('run: failure message keeps the child stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', ...Array(1000).fill('argument')];
  await assert.rejects(exec.run(process.execPath, args), (err: Error) => err.message.includes('BOOM-STDERR'));
});

test('run keeps complete error text and summarizes oversized argument tokens', async () => {
  const diagnostic = 'x'.repeat(3990) + '/private/worktree/secret-file';
  const argument = 'y'.repeat(290) + '/private/worktree/argument';
  await assert.rejects(
    exec.run(process.execPath, ['-e', 'process.stderr.write(process.argv[1]); process.exit(2)', diagnostic, argument]),
    (err: Error) =>
      err.message.includes(diagnostic) &&
      err.message.includes(`<${argument.length} chars>`) &&
      !err.message.includes(argument),
  );
});

test('a long commit message does not displace a failing hook reason from the fenced error', async () => {
  const repo = join(scratch, 'hook-repo');
  await exec.run('git', ['init', '-q', repo]);
  writeFileSync(
    join(repo, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\necho "Hook rejected: run lint first" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const message = 'feat: Ticket\n\n' + 'Summary detail.\n'.repeat(230);
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=.git/hooks'];
  await assert.rejects(
    exec.run('git', [...identity, 'commit', '--allow-empty', '-q', '-m', message], { cwd: repo }),
    (err: exec.CommandError) => {
      assert.ok(err.stderr.includes('Hook rejected: run lint first'), 'the hook ran');
      assert.ok(render.fence(err.message).includes('Hook rejected: run lint first'));
      return true;
    },
  );
});

// A shell would split the argument at & and |.
test('run never spawns through a shell', async () => {
  const result = await exec.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a&b|c']);
  assert.equal(result.stdout, 'a&b|c');
});
