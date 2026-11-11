import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as exec from '../../lib/exec.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as rescue from '../../lib/rescue.ts';
import * as addSuite from '../support/add-suite.ts';
import * as childScripts from '../support/child-scripts.ts';
import { intents, loadTicket } from '../support/execution-reads.ts';
import type * as fakeHarness from '../support/fake-harness.ts';
import * as gitShell from '../support/git-shell.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import { terminalReasonOf } from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as processProbe from '../support/process-probe.ts';
import * as rescueFlow from '../support/rescue-flow.ts';
import * as reviewFlow from '../support/review-flow.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// Rescue Refs: a failed Vertex's work leaves the worktree when its route goes on to a Vertex (#118; R5, U5, W3, N4).
// green fails its Check in the recovery pass, so its rescue is an Action of recovery 1.
const rescueMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'green', 1, 'rescue', 1, 1);
const greenResetMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'green', 1, 'reset', 1, 1);
const greenRescueRef = (fixture: golden.GoldenFixture) => rescue.rescueRef(rescueMarker(fixture));
const inWorktree = (fixture: golden.GoldenFixture, path: string) => existsSync(join(fixture.worktree, path));
const failedThenRight = () => ({ ...rescueFlow.failingGreen(), ...rescueFlow.rightSenior() });

// The resets a Run makes, across every run of the case.
function countResets(fixture: golden.GoldenFixture) {
  const { git } = fixture.options.deps;
  const counted = { resets: 0 };
  fixture.options.deps.git = {
    ...git,
    resetTo: async (...args) => {
      counted.resets += 1;
      return git.resetTo(...args);
    },
  };
  return counted;
}

test('a failure routed to a Vertex is rescued and reset', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  const ref = greenRescueRef(fixture);
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what green tried');
  assert.equal(rescueFlow.inRef(fixture, ref, 'lib/add.mjs'), 'export const add = () => 0;');
  assert.equal(inWorktree(fixture, 'notes.txt'), false, 'the failed work left the worktree');
  const rescued = fixture.executionRecord.history.filter((item) => String(item.text).includes(ref));
  assert.equal(rescued.length, 1, 'one History item names the failure and the ref');
  assert.match(String(rescued[0]!.text), /test .*failed/);
  assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
    red: 1,
    green: 1,
    'senior-green': 1,
    publish: 1,
  });
});

test('a failure routed to an end is left in place', async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: rescueFlow.failingGreen(),
    integrity: 'real',
    git: 'real',
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'needs-human');
  assert.deepEqual(rescueFlow.rescueRefs(fixture), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(readFileSync(join(fixture.worktree, 'notes.txt'), 'utf8'), 'what green tried\n');
});

test('the next Vertex reads the rescue output', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, {
    ...rescueFlow.failingGreen(),
    [rescueFlow.SENIOR_CALL]: {
      files: {},
      response: { ...golden.greenResponse, claim: 'blocked', diagnosis: 'stuck' },
    },
  });
  await interpreter.runExecution(fixture.options);
  assert.deepEqual(fixture.executionRecord.configurationSnapshot!.inputs.previous, {
    value: {
      ref: greenRescueRef(fixture),
      diffStat: { files: 2, insertions: 2, deletions: 0, testFiles: 0, testInsertions: 0 },
      output: golden.GREEN_FAIL_OUTPUT,
    },
    vertex: 'green',
    visit: 1,
    action: 'rescue',
    absent: false,
  });
});

test('an existing rescue ref is never overwritten', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const ref = greenRescueRef(fixture);
  gitShell.sh(fixture.worktree, 'update-ref', ref, fixture.base);
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', ref), fixture.base, 'the ref keeps what it held');
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'nothing was reset');
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.ok(terminalReasonOf(fixture).text.includes(ref), 'the hold names the Rescue Ref');
});

test('ignored test files are kept in the rescue', async (t) => {
  const fixture = await goldenRun.greenFixture(t, {
    responses: rescueFlow.failingRed({ 'test/generated/ignored.test.mjs': 'an ignored test\n' }),
    integrity: 'real',
    git: 'real',
  });
  writeFileSync(join(fixture.commonDir, 'info', 'exclude'), 'test/generated/\n');
  golden.configure(fixture, rescueFlow.routeRedFailureToSenior);
  await interpreter.runExecution(fixture.options);
  const ref = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'red', 1, 'rescue', 1, 1));
  assert.equal(rescueFlow.inRef(fixture, ref, 'test/generated/ignored.test.mjs'), 'an ignored test');
  assert.equal(inWorktree(fixture, 'test/generated/ignored.test.mjs'), false, 'the reset removed it');
});

test('a reset that leaves the worktree unlike the baseline holds', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    resetTo: async (...args) => {
      await git.resetTo(...args);
      writeFileSync(join(fixture.worktree, 'stray.txt'), 'a writer nobody knew of\n');
    },
  };
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.ok(terminalReasonOf(fixture).text.includes(greenRescueRef(fixture)), 'the hold names the Rescue Ref');
  assert.deepEqual(
    fixture.harness.calls.map((call) => call.marker).filter((call) => call?.includes('senior-green')),
    [],
  );
});

const RESCUE_CRASHES: Record<
  string,
  (fixture: golden.GoldenFixture) => NonNullable<interpreter.ExecutionOptions['crashAt']>
> = {
  'after its ref is made': (fixture) => ({ marker: rescueMarker(fixture), point: 'after-effect' }),
  'before the reset': (fixture) => ({ marker: greenResetMarker(fixture), point: 'before-effect' }),
  'after the reset': (fixture) => ({ marker: greenResetMarker(fixture), point: 'after-effect' }),
};
for (const [place, crashAt] of Object.entries(RESCUE_CRASHES)) {
  test(`a crash during the rescue or the reset resumes at the next step: ${place}`, async (t) => {
    const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
    const counted = countResets(fixture);
    await assert.rejects(
      interpreter.runExecution({ ...fixture.options, crashAt: crashAt(fixture) }),
      (err) => err instanceof interpreter.CrashError,
    );
    const loaded = loadTicket(fixture);
    const dirty = await reconcile.dirtyState(loaded, {
      git: fixture.options.deps.git,
      worktree: fixture.worktree,
    });
    assert.equal(dirty, null, "admission reads the rescue's own state as proven");
    const { outcome } = await interpreter.runExecution({ ...fixture.options, record: loaded });
    assert.equal(outcome, 'ready-for-qa');
    assert.deepEqual(rescueFlow.rescueRefs(fixture), [greenRescueRef(fixture)], 'no second ref');
    assert.equal(counted.resets, 1, 'no repeated reset');
    const saved = loadTicket(fixture);
    assert.equal(saved.history.filter((item) => item.kind === 'rescued').length, 1, 'one History item');
    assert.equal(inWorktree(fixture, 'notes.txt'), false);
  });
}

test('a reset that cannot remove a locked file holds with the state rescued', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    resetTo: async () => {
      throw new exec.CommandError('git reset failed', {
        code: 1,
        stdout: '',
        stderr: "error: unable to unlink old 'lib/add.mjs': Permission denied",
      });
    },
  };
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.held, true);
  const ref = greenRescueRef(fixture);
  assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what green tried', 'the work is in the ref');
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'and still in the worktree');
  assert.ok(terminalReasonOf(fixture).text.includes(ref), 'the hold names the Rescue Ref');
});

test('a clean worktree is not rescued or reset', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, {
    [rescueFlow.GREEN_CALL]: goldenRun.greenWrites({}),
    [rescueFlow.GREEN_RECOVERY]: goldenRun.greenWrites({}),
    ...rescueFlow.rightSenior(),
  });
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.deepEqual(Object.fromEntries(fixture.executionRecord.visits), {
    red: 1,
    green: 1,
    'senior-green': 1,
    publish: 1,
  });
  assert.deepEqual(rescueFlow.rescueRefs(fixture), []);
  assert.deepEqual(intents(fixture.executionRecord, 'rescue'), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.deepEqual(
    fixture.executionRecord.outputs.filter((output) => output.action === 'rescue'),
    [],
  );
});

test('a background writer left by a returned call is killed before the rescue', async (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-writer-');
  const pidFile = join(directory, 'writer.pid');
  t.after(() => processProbe.endProcessIn(pidFile));
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  // green's first Check runs a real command, which changes the worktree, exits 1 and leaves a writer running there. A
  // Check that changed the worktree has no recovery, so the Vertex fails at once.
  const suite = fixture.options.deps.exec;
  const real = exec.createExec();
  let first = true;
  fixture.options.deps.exec = {
    ...suite,
    runShell: (command, options) => {
      if (!existsSync(join(fixture.worktree, 'lib', 'add.mjs')) || !first) return suite.runShell(command, options);
      first = false;
      const writes = childScripts.nodeCommand(
        t,
        childScripts.BACKGROUND_STARTER,
        'ignore',
        '1',
        pidFile,
        childScripts.BACKGROUND_WRITER,
        join(fixture.worktree, 'writer.log'),
      );
      return real.runShell(writes, options);
    },
  };
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'ready-for-qa');
  assert.equal(processProbe.alive(processProbe.pidIn(pidFile)), false, 'the writer is gone');
  assert.equal(inWorktree(fixture, 'writer.log'), false, 'nothing wrote after the reset');
  const ref = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'green', 1, 'rescue', 0, 1));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  assert.match(rescueFlow.inRef(fixture, ref, 'writer.log'), /more/);
});

// The golden traces of a failed fix: escalated with its work rescued, and left in place once the escalation is spent.
const reviewCall = (visitNumber: number) => keys.responseKey('reviewer', visitNumber, 'review', 1);
const fixCall = (vertex: string, visitNumber = 1) => keys.responseKey(vertex, visitNumber, 'fix', 1);
const fixRecovery = (visitNumber = 1) => keys.responseKey('implementer-fix', visitNumber, 'recover', 1);
const wrongFix = () => reviewFlow.fixed({ 'lib/add.mjs': goldenRun.WRONG_ADD });

// A failed implementer-fix escalates to senior-dev, which reads the failed work as `previous`, once; then it ends.
async function escalatingFix(t: TestContext, responses: fakeHarness.ScriptedResponses) {
  const fixture = await reviewFlow.reviewFixture(t, responses, {
    integrity: 'real',
    git: 'real',
    configure: (configured) => {
      const { vertices } = configured.flows.golden!.ticket;
      vertices['implementer-fix']!.route = {
        ok: 'reviewer',
        failed: { to: 'senior-dev', max: 1, exhausted: { end: 'needs-human' } },
      };
      vertices['senior-dev']!.inputs = {
        ...reviewFlow.FIX_INPUTS,
        previous: { from: 'implementer-fix.rescue', optional: true },
      };
    },
  });
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true });
  return goldenRun.ranToEnd(fixture);
}
const fixTrace = (fixture: goldenRun.GoldenRun) =>
  golden
    .trace(fixture.events)
    .filter((event) => ['implementer-fix', 'senior-dev'].includes(event.vertex))
    .map(golden.line((event) => `${event.vertex}/${event.action}/${event.recovery}`));

test('golden: a failed fix is rescued into an escalation Vertex', async (t) => {
  const fixture = await escalatingFix(t, {
    [reviewCall(1)]: reviewFlow.reviewed(reviewFlow.review('changes', [reviewFlow.MAJOR])),
    [fixCall('implementer-fix')]: wrongFix(),
    [fixRecovery()]: wrongFix(),
    [fixCall('senior-dev')]: reviewFlow.fixed({
      'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b); // a + b\n',
    }),
    [reviewCall(2)]: reviewFlow.reviewed(reviewFlow.review('ok')),
  });
  assert.equal(fixture.result.outcome, 'ready-for-qa');
  assert.deepEqual(fixTrace(fixture), [
    'implementer-fix/fix/0',
    'implementer-fix/test/0',
    'implementer-fix/fix/1',
    'implementer-fix/test/1',
    'implementer-fix/rescue/1',
    'implementer-fix failed -> senior-dev',
    'senior-dev/fix/0',
    'senior-dev/test/0',
    'senior-dev/commit/0',
    'senior-dev/push/0',
    'senior-dev/pr/0',
    'senior-dev ok -> reviewer',
  ]);
  const ref = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'rescue', 1, 1));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  assert.equal(rescueFlow.inRef(fixture, ref, 'lib/add.mjs'), 'export const add = () => 0;');
});

test('golden: the same failure is left in place once the escalation is exhausted', async (t) => {
  const fixture = await escalatingFix(t, {
    [reviewCall(1)]: reviewFlow.reviewed(reviewFlow.review('changes', [reviewFlow.MAJOR])),
    [fixCall('implementer-fix')]: wrongFix(),
    [fixRecovery()]: wrongFix(),
    [fixCall('senior-dev')]: reviewFlow.fixed({
      'lib/add.mjs': 'export const add = (a, b) => Number(a) + Number(b); // a + b\n',
    }),
    [reviewCall(2)]: reviewFlow.reviewed(
      reviewFlow.review('changes', [reviewFlow.finding('major', 'lib/add.mjs', 'another problem')]),
    ),
    [fixCall('implementer-fix', 2)]: wrongFix(),
    [fixRecovery(2)]: wrongFix(),
  });
  assert.equal(fixture.result.outcome, 'needs-human');
  assert.deepEqual(fixTrace(fixture).slice(-4), [
    'implementer-fix/test/0',
    'implementer-fix/fix/1',
    'implementer-fix/test/1',
    'implementer-fix failed -> needs-human',
  ]);
  const first = rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'implementer-fix', 1, 'rescue', 1, 1));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [first], 'only the failure that escalated was rescued');
  assert.equal(readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8'), goldenRun.WRONG_ADD);
  assert.match(fixture.executionRecord.terminalReason!.text, /had used its Bound/);
});

// resetTo is two git processes, so gg can die between them: the tracked files are back, and the untracked ones are
// still as the agent left them. A tracked file must have changed, or the reset changes nothing and the worktree still
// reads as the agent left it.
const changesTracked = () => {
  const work = goldenRun.greenWrites({ ...rescueFlow.FAILING_WORK, 'package.json': '{"name":"changed"}\n' });
  return { [rescueFlow.GREEN_CALL]: work, [rescueFlow.GREEN_RECOVERY]: work, ...rescueFlow.rightSenior() };
};

test('a crash between the hard reset and the clean resumes by finishing the clean', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, changesTracked());
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    resetTo: async (_worktree, sha) => {
      gitShell.sh(fixture.worktree, 'reset', '-q', '--hard', sha);
      throw new interpreter.CrashError('crash between the reset and the clean');
    },
  };
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'the crash came before the clean');
  fixture.options.deps.git = git;
  const loaded = loadTicket(fixture);
  assert.equal(await reconcile.dirtyState(loaded, { git, worktree: fixture.worktree }), null);
  const { outcome } = await interpreter.runExecution({ ...fixture.options, record: loaded });
  assert.equal(outcome, 'ready-for-qa');
  assert.equal(inWorktree(fixture, 'notes.txt'), false);
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [greenRescueRef(fixture)]);
});

// Only what the record proves the agent left may be cleaned: a file a human added after the crash holds instead.
test('after a crash between the hard reset and the clean, a file the agent did not leave holds', async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, changesTracked());
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    resetTo: async (_worktree, sha) => {
      gitShell.sh(fixture.worktree, 'reset', '-q', '--hard', sha);
      throw new interpreter.CrashError('crash between the reset and the clean');
    },
  };
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  fixture.options.deps.git = git;
  writeFileSync(join(fixture.worktree, 'by-hand.txt'), 'a human wrote this\n');
  const loaded = loadTicket(fixture);
  const result = await interpreter.runExecution({ ...fixture.options, record: loaded });
  assert.equal(result.held, true);
  assert.equal(inWorktree(fixture, 'by-hand.txt'), true, 'nothing was discarded');
  assert.ok(loaded.terminalReason!.text.includes(greenRescueRef(fixture)), 'the hold names the Rescue Ref');
});

test("dirtyState finds the Rescue Ref a crash left before saving the ref's evidence", async (t) => {
  const fixture = await rescueFlow.rescueFixture(t, failedThenRight());
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: rescueMarker(fixture), point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  writeFileSync(join(fixture.worktree, 'by-hand.txt'), 'a human wrote this\n');
  const dirty = await reconcile.dirtyState(loadTicket(fixture), {
    git: fixture.options.deps.git,
    worktree: fixture.worktree,
  });
  assert.equal(dirty?.rescueRef, greenRescueRef(fixture));
});
