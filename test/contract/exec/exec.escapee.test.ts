// lib/exec.ts's contract on Windows for a process its command starts outside gg's job, as Windows starts a packaged
// app's (ADR 0030 decision 3): the watcher of a launch and of a Check's shell runner adopts or ends each such escapee,
// and its cleanup confirms it gone or names it. A kernel32 copy lets Git Bash's node break away from the job
// (kernel32Doubles.breakawayJobs), and refuses the adoptions a case names.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const escapee = pidIn(pidFile);
    assert.equal(alive(escapee), false, `escapee ${escapee} runs on past the result`);
    assert.deepEqual(cleanup, CONTAINED);
    const order = attempts.get(escapee)?.slice(0, 3);
    assert.deepEqual(order, ['gg-job', 'new-job', 'terminate'], JSON.stringify([...attempts]));
  });

  test(`${site.name}: an escapee gg cannot end is a survivor with confirmed false`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-survivor.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs(['gg-job', 'new-job', 'terminate']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
    const escapee = pidIn(pidFile);
    assert.equal(cleanup.confirmed, false, JSON.stringify(cleanup));
    const survivor = cleanup.survivors.find((listed) => listed.pid === escapee);
    assert.ok(survivor, `escapee ${escapee} missing from ${JSON.stringify(cleanup.survivors)}`);
    assert.match(survivor.commandLine ?? '', /long-lived/);
    assert.ok(alive(escapee), 'it was named as running');
  });

  // The escapee sits in a job of its own whose termination is refused, so only closing that job's handle ends it.
  test(`${site.name}: a held cleanup's closeJob ends an escapee adopted into a job of its own`, WIN_CASE, async (t) => {
    const pidFile = join(scratch, `${site.name}-close-job.pid`);
    t.after(() => processProbe.endProcessIn(pidFile));
    const { kernel32 } = kernel32Doubles.breakawayJobs(['gg-job', 'terminate']);
    const { cleanup } = await site.finishes(kernel32, gitBash.backgroundNode(pidFile));
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
