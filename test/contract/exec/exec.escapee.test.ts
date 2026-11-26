// lib/exec.ts's contract on Windows for a process its command starts outside gg's job, as Windows starts a packaged
// app's (ADR 0030 decision 3): the watcher of a launch and of a Check's shell runner adopts or ends each such escapee,
// and its cleanup confirms it gone or names it. A kernel32 copy lets Git Bash's node break away from the job
// (kernel32Doubles.breakawayJobs), and refuses the adoptions a case names.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import type * as commandCleanup from '../../../lib/command-cleanup.ts';
import type * as containment from '../../../lib/containment.ts';
import * as exec from '../../../lib/exec.ts';
import * as childScripts from '../../support/child-scripts.ts';
import * as gitBash from '../../support/git-bash.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';
import * as timedOutShell from '../../support/timed-out-shell.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-escapee-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { WIN_CASE } = options;
const { alive, pidIn, waitFor } = processProbe;

const CONTAINED = { confirmed: true, survivors: [], reason: null, containment: { kind: 'job' } };

type Ran = { cleanup: commandCleanup.CleanupReport; timedOut: boolean };
type Kernel32 = containment.Kernel32;

// A place gg holds a Windows command in a job, by the call in the code that starts it, and how a case runs a Git
// Bash script there: to its own end, or timed out once the script's node has written pidFile.
type Site = {
  call: string;
  name: string;
  escapee: string;
  finishes: (kernel32: Kernel32, script: string) => Promise<Ran>;
  timesOut: (kernel32: Kernel32, script: string, pidFile: string, t: TestContext) => Promise<Ran>;
};

const SITES: Site[] = [
  {
    call: 'lib/exec.ts: containment.startArgv',
    name: 'launch',
    escapee: "a launch's escapee",
    finishes: async (kernel32, script) => {
      const launched = { command: gitBash.gitBash(), args: ['-c', script], wallMs: 60_000 };
      const { cleanup, timedOut } = await exec.createExec({ kernel32 }).launch(launched);
      return { cleanup, timedOut: timedOut !== null };
    },
    timesOut: async (kernel32, script, pidFile, t) => {
      const { cleanup, timedOut } = await exec.createExec({ kernel32 }).launch({
        command: gitBash.gitBash(),
        args: ['-c', script],
        wallMs: 200,
        testHooks: { signal: processProbe.pidWritten(pidFile, t.signal) },
      });
      return { cleanup, timedOut: timedOut !== null };
    },
  },
  {
    call: 'lib/exec.ts: containment.start',
    name: 'runShell',
    escapee: 'a runShell escapee',
    finishes: async (kernel32, script) => {
      const commandLine = `"${gitBash.gitBash()}" -c "${script}"`;
      const { cleanup, timedOut } = await exec.createExec({ kernel32 }).runShell(commandLine, { timeoutMs: 60_000 });
      return { cleanup, timedOut: timedOut === true };
    },
    timesOut: async (kernel32, script, pidFile, t) => {
      const { result } = await timedOutShell.timeOutWhen(
        `"${gitBash.gitBash()}" -c "${script}"`,
        { timeoutMs: 200, kernel32 },
        () => pidIn(pidFile) > 0,
        t,
      );
      return { cleanup: result.cleanup, timedOut: result.timedOut === true };
    },
  },
];

// The places gg holds a Windows command in a job but runs no watcher, as ADR 0030 decision 3 names a launch and a Check
// only.
const EXCLUDED: Record<string, string> = {
  'scripts/run-suite.ts: createJob': "the suite launcher's own job, around the stage it runs",
  'scripts/record-codex-run.ts: containment.startArgv': 'the Codex recorder, run by hand and never by gg',
};

// Each call in files that holds a Windows command in a job, as `path: call`: lib/containment.ts's start, startArgv and
// createJob, outside containment.ts itself, whose own createJob serves start and startArgv.
function jobSites(files: { path: string; text: string }[]) {
  const call = /(?<![\w.])(containment\.(?:startArgv|start|createJob)|createJob)\(/g;
  return files
    .filter(({ path }) => path !== 'lib/containment.ts')
    .flatMap(({ path, text }) =>
      [...text.matchAll(call)]
        .filter((match) => !text.slice(0, match.index).endsWith('function '))
        .map((match) => `${path}: ${match[1]}`),
    );
}

const repository = new URL('../../../', import.meta.url);
const codeFiles = () =>
  ['bin', 'lib', 'scripts'].flatMap((root) =>
    readdirSync(new URL(root, repository), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => {
        const path = `${root}/${name.replaceAll('\\', '/')}`;
        return { path, text: readFileSync(new URL(path, repository), 'utf8') };
      }),
  );

// Rule 1 of #531's record: every Windows command gg holds in a job runs the watcher, so each such call in the code is a
// site the cases below run, or excluded by name. A call added beside them is found, as the sample shows.
test('every call that holds a Windows command in a job is a site the escapee cases run, or excluded by name', () => {
  const sites = jobSites(codeFiles());
  assert.deepEqual(sites.toSorted(), [...SITES.map(({ call }) => call), ...Object.keys(EXCLUDED)].toSorted());
  const sample = { path: 'lib/sample.ts', text: 'const started = containment.start(kernel32, line, cwd);' };
  assert.deepEqual(jobSites([sample]), ['lib/sample.ts: containment.start']);
});

for (const site of SITES) {
  // The first Adoption is into gg's job (ADR 0030 decision 3); the job's termination then ends it.
  test(`${site.escapee} is ended`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-ended.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32, attempts } = kernel32Doubles.breakawayJobs();
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    const escapee = pidIn(pidFile);
    assert.equal(alive(escapee), false, `escapee ${escapee} runs on past the result`);
    assert.deepEqual(cleanup, CONTAINED);
    assert.deepEqual(attempts.get(escapee)?.slice(0, 1), ['gg-job'], JSON.stringify([...attempts]));
  });

  test(`${site.escapee} is ended when its command times out`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-timed-out.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs();
    const ran = await site.timesOut(kernel32, gitBash.backgroundNode(pidFile, { waits: true }), pidFile, t);
    const escapee = pidIn(pidFile);
    assert.equal(ran.timedOut, true);
    assert.equal(alive(escapee), false, `escapee ${escapee} runs on past the result`);
    assert.deepEqual(ran.cleanup, CONTAINED);
  });

  // gg's job refusing it, the escapee goes into a new kill-on-close job, which the cleanup ends.
  test(`${site.escapee} that gg's job refuses is adopted into a new job and ended`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-new-job.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32, attempts } = kernel32Doubles.breakawayJobs(['gg-job']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    const escapee = pidIn(pidFile);
    assert.equal(alive(escapee), false, `escapee ${escapee} runs on past the result`);
    assert.deepEqual(cleanup, CONTAINED);
    assert.deepEqual(attempts.get(escapee)?.slice(0, 2), ['gg-job', 'new-job'], JSON.stringify([...attempts]));
  });

  test(`${site.escapee} that no job takes is terminated`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-terminated.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32, attempts } = kernel32Doubles.breakawayJobs(['gg-job', 'new-job']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    // Ended at first sight, maybe before it wrote its pid, so each process whose adoption was tried is checked. One
    // never linked runs on and writes its pid, which then names a process tried.
    const written = pidIn(pidFile);
    if (written)
      assert.ok(attempts.has(written), `escapee ${written} was never adopted: ${JSON.stringify([...attempts])}`);
    assert.ok(attempts.size > 0, 'no adoption was tried');
    for (const [escapee, order] of attempts) {
      assert.equal(alive(escapee), false, `escapee ${escapee} runs on past the result`);
      assert.deepEqual(order.slice(0, 3), ['gg-job', 'new-job', 'terminate'], JSON.stringify([...attempts]));
    }
    assert.deepEqual(cleanup, CONTAINED);
  });

  test(`${site.name}: an escapee gg cannot end is a survivor with confirmed false`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-survivor.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs(['gg-job', 'new-job', 'terminate']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    t.after(() => cleanup.closeJob?.());
    const escapee = pidIn(pidFile);
    assert.equal(cleanup.confirmed, false, JSON.stringify(cleanup));
    const survivor = cleanup.survivors.find((listed) => listed.pid === escapee);
    assert.ok(survivor, `escapee ${escapee} missing from ${JSON.stringify(cleanup.survivors)}`);
    assert.match(survivor.commandLine ?? '', /long-lived/);
    assert.ok(alive(escapee), 'it was named as running');
  });

  // Closed to gg, as one run under another account is, the escapee can be neither held nor ended (#531 decision 1).
  test(`${site.name}: an escapee gg cannot read is a survivor with confirmed false`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-closed.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs([], { closedOutside: true });
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    t.after(() => cleanup.closeJob?.());
    const escapee = pidIn(pidFile);
    assert.equal(cleanup.confirmed, false, JSON.stringify(cleanup));
    const survivor = cleanup.survivors.find((listed) => listed.pid === escapee);
    assert.ok(survivor, `escapee ${escapee} missing from ${JSON.stringify(cleanup.survivors)}`);
    assert.ok(alive(escapee), 'it was named as running');
  });

  // The escapee sits in a job of its own whose termination is refused, so only closing that job's handle ends it.
  test(`${site.name}: a held cleanup's closeJob ends an escapee adopted into a job of its own`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-close-job.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs(['gg-job', 'terminate']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    t.after(() => cleanup.closeJob?.());
    const escapee = pidIn(pidFile);
    assert.equal(cleanup.confirmed, false, JSON.stringify(cleanup));
    assert.ok(alive(escapee), 'refused, it runs on');
    cleanup.closeJob!();
    await waitFor(() => !alive(escapee), t.signal); // one left running fails at the case timeout
  });

  // gg's job refusing it, as it refuses a packaged app's process, the escapee goes into a job of its own, so its child
  // starts outside gg's job whether or not the escapee was adopted yet, is linked through it and adopted in its turn.
  test(`${site.escapee}'s child is adopted in its turn and ended`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-child.pid`);
    t.after(() => processProbe.endProcessIn(pidFile)); // its parent, the escapee, ends with it
    const { kernel32, attempts } = kernel32Doubles.breakawayJobs(['gg-job']);
    const scripts = [childScripts.LINKED_STARTER, childScripts.LONG_LIVED];
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile, { scripts }));
    const child = pidIn(pidFile);
    assert.equal(alive(child), false, `the escapee's child ${child} runs on past the result`);
    assert.deepEqual(cleanup, CONTAINED);
    assert.ok(attempts.has(child), `no adoption of ${child} was tried: ${JSON.stringify([...attempts])}`);
  });
}

// The calls of one process snapshot, any of which a loaded machine makes slow.
const SNAPSHOT_CALLS = ['CreateToolhelp32Snapshot', 'Process32FirstW', 'Process32NextW'] as const;
type SnapshotCall = (typeof SNAPSHOT_CALLS)[number];
const SLOW_MS = 1500;

// A kernel32 whose call slow blocks the thread that makes it for SLOW_MS once in each snapshot walk, as a snapshot on a
// loaded machine does, and made(), the count of those it has slowed.
function slowSnapshot(slow: SnapshotCall) {
  const real = kernel32Doubles.realKernel32!;
  let made = 0;
  let walking = false; // Process32NextW is called per entry, and blocks on the first of each walk only
  const blockIf = (call: SnapshotCall) => {
    if (call !== slow || (call === 'Process32NextW' && walking)) return;
    made++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_MS);
  };
  const kernel32 = kernel32Doubles.withKernel32({
    CreateToolhelp32Snapshot: (...args) => {
      blockIf('CreateToolhelp32Snapshot');
      return real.CreateToolhelp32Snapshot(...args);
    },
    Process32FirstW: (...args) => {
      blockIf('Process32FirstW');
      walking = false;
      return real.Process32FirstW(...args);
    },
    Process32NextW: (...args) => {
      blockIf('Process32NextW');
      walking = true;
      return real.Process32NextW(...args);
    },
  });
  return { kernel32, made: () => made };
}

// The watcher's periodic snapshot must not block gg's thread, where the stall, wall and heartbeat clocks that judge the
// command run (#531 D1). Periodic snapshots run on a thread of their own with its own kernel32, so the slowed calls of
// the kernel32 the case passes reach only gg's thread. The case counts them once the snapshot thread has answered
// twice, and the command waits on a go file written after that count, so cleanup's last poll, on gg's thread, comes
// after it. The case reads no real time (#531 D4 B): a slowed call on gg's thread is what would block its timers.
for (const site of SITES)
  for (const call of SNAPSHOT_CALLS)
    test(`${site.name}'s watcher keeps its snapshots off gg's thread while ${call} is slow`, WIN_CASE, async () => {
      const go = join(scratch, `timers-${site.name}-${call}.go`).split(sep).join('/');
      let answered = () => {};
      const answeredTwice = new Promise<void>((resolve) => (answered = resolve));
      let answers = 0;
      const onWorker = (worker: Worker) => worker.on('message', () => ++answers === 2 && answered());
      process.on('worker', onWorker);
      const slowed = slowSnapshot(call);
      const ran = site.finishes(slowed.kernel32, `until [ -e ${go} ]; do sleep 0.1; done`);
      await answeredTwice;
      const madeOnGgThread = slowed.made();
      writeFileSync(go, '');
      await ran;
      process.off('worker', onWorker);
      assert.deepEqual({ madeOnGgThread }, { madeOnGgThread: 0 });
    });
