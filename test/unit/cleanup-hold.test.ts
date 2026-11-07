// A Pending cleanup hold through the interpreter: a call or Check whose cleanup could not be confirmed ends the Run
// for its Ticket, and a later Run that confirms it afresh finishes the Action as if it had just returned (L11, L14,
// L15, J4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as commandCleanup from '../../lib/command-cleanup.ts';
import * as interpreter from '../../lib/interpreter.ts';
import { laterRun } from '../support/approval-flow.ts';
import { actionEvent, attemptsOf, intents, loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import * as keys from '../support/keys.ts';
import { editRuns } from '../support/suite-runs.ts';

const CLEANUP_LABEL = 'gg:await:cleanup';
const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RETRY = keys.responseKey('green', 1, 'green', 2);
const RED_CALL = keys.responseKey('red', 1, 'red', 1);
const UNCONFIRMED: commandCleanup.CleanupReport = {
  confirmed: false,
  survivors: [
    { pid: 4242, created: '2026-11-06T00:00:00.000Z', commandLine: 'node writer.js', error: 'still running' },
  ],
  reason: 'termination refused',
  containment: { kind: 'group', pgid: 4242 },
};

// The golden fixture whose green Check holds, its first run only.
async function heldCheck(t: Parameters<typeof golden.fixture>[0], report = UNCONFIRMED) {
  const fixture = await golden.fixture(t);
  let held = false;
  editRuns(fixture, (run) => {
    if (held || run.code !== 0 || fixture.executionRecord.cursor.vertex !== 'green') return run;
    held = true;
    return { ...run, cleanup: report };
  });
  return fixture;
}

const holdComments = (fixture: golden.GoldenFixture) =>
  fixture.gh.comments.map((comment) => comment.body).filter((body) => body.includes('gg: cleanup hold'));

test('an exit-0 Check with unconfirmed cleanup ends the Run Pending before the commit', async (t) => {
  const fixture = await heldCheck(t);
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.equal(saved.state, 'active');
  assert.deepEqual(saved.visitState!.unconfirmedCleanup, UNCONFIRMED);
  assert.equal(saved.activity.busy, true, 'the worktree is not marked idle');
  assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), true);
  const [comment, ...others] = holdComments(fixture);
  assert.deepEqual(others, []);
  assert.match(comment!, /4242/);
  assert.match(comment!, /node writer\.js/);
  assert.match(comment!, /termination refused/);
  assert.equal(attemptsOf(fixture, 'green', 'commit').length, 0, 'nothing was committed');
});

test('a successful agent response with unconfirmed cleanup ends the Run Pending before its Checks', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: { ...golden.firstVisitResponses[GREEN_CALL], cleanup: UNCONFIRMED },
    }),
  });
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.outcome, 'pending');
  assert.equal(actionEvent(fixture, 'green', 'test'), undefined, 'its Check never ran');
  assert.deepEqual(actionEvent(fixture, 'green', 'green')!.cleanup, UNCONFIRMED);
  assert.deepEqual((await loadTicket(fixture)).visitState!.unconfirmedCleanup, UNCONFIRMED);
});

test('a Harness result that reports no cleanup ends the Run Pending with no containment to check', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: { ...golden.firstVisitResponses[GREEN_CALL], result: { cleanup: undefined } },
    }),
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.match(holdComments(fixture)[0]!, /the Harness reported no cleanup/);
});

test('a cleanup hold resumes when its survivors are gone and the tree is unchanged', async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  const checks = fixture.shells.length;

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa');
  const saved = await loadTicket(fixture);
  assert.equal(saved.visitState!.unconfirmedCleanup, null);
  assert.equal(saved.activity.busy, false, 'the worktree is idle again');
  assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), false, 'the Await Label is taken down');
  assert.equal(holdComments(fixture).length, 1);
  assert.equal(attemptsOf(fixture, 'green', 'commit').length, 1);
  // The publish Vertex's own Check ran; green's result stood.
  assert.equal(fixture.shells.length, checks + 1);
  assert.deepEqual(
    saved.outputs.find((output) => output.vertex === 'green' && output.action === 'test')!.value.cleanup,
    { confirmed: true, survivors: [], reason: null, containment: UNCONFIRMED.containment },
    'the output says what was finally confirmed',
  );
});

test("a cleanup hold whose tree changed re-runs the Visit's Checks", async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  const checks = fixture.shells.length;
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'what a survivor wrote\n');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa');
  assert.equal(fixture.shells.length, checks + 2, "green's Check ran again, then publish's");
  const trace = attemptsOf(fixture, 'green', 'test');
  assert.equal(trace.length, 2, "the held result and the re-run's");
  assert.equal(attemptsOf(fixture, 'green', 'commit').length, 1);
});

test('a re-run Check that holds again posts its own hold', async (t) => {
  const fixture = await golden.fixture(t);
  let held = 0;
  editRuns(fixture, (run) => {
    if (run.code !== 0 || fixture.executionRecord.cursor.vertex !== 'green' || held >= 1) return run;
    held += 1;
    return { ...run, cleanup: UNCONFIRMED };
  });
  await interpreter.runExecution(fixture.options);
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'what a survivor wrote\n');
  // Its re-run, in the later Run, holds too.
  const relabel = fixture.options.deps.exec.runShell;
  fixture.options.deps.exec.runShell = (async (command: string, options?: { cwd?: string }) => ({
    ...(await (relabel as (given: string, givenOptions?: object) => Promise<object>)(command, options)),
    cleanup: UNCONFIRMED,
  })) as typeof relabel;
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(holdComments(fixture).length, 2);
  assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), true);
});

test('a cleanup hold stays Pending while a survivor runs', async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  fixture.options.deps.exec.cleanupConfirmed = () => false;

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.deepEqual(saved.visitState!.unconfirmedCleanup, UNCONFIRMED);
  assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), true);
  assert.equal(holdComments(fixture).length, 1, 'it asks once');
  assert.equal(attemptsOf(fixture, 'green', 'commit').length, 0);
});

test('a hold with no containment stays held with an empty survivor list', async (t) => {
  const report: commandCleanup.CleanupReport = {
    confirmed: false,
    survivors: [],
    reason: 'the command ran uncontained, so its orphans cannot be found',
    containment: { kind: 'none' },
  };
  const fixture = await heldCheck(t, report);
  await interpreter.runExecution(fixture.options);

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), true);
  assert.match(holdComments(fixture)[0]!, /gg:state:needs-human/);
});

test('a human needs-human label abandons a Pending cleanup hold', async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  fixture.options.deps.exec.cleanupConfirmed = () => false;
  fixture.gh.labels.add('gg:state:needs-human');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'abandoned');
});

test('a timed-out call held for cleanup retries once on resume, then ends harness-timeout', async (t) => {
  const timedOut = { status: 'timed-out' };
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: { files: {}, response: null, cleanup: UNCONFIRMED, result: timedOut },
      [GREEN_RETRY]: { files: {}, response: null, result: timedOut },
    }),
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  assert.equal(fixture.harness.calls.length, 2, 'red and the held green');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.harness.calls.length, 3, 'one retry');
  const saved = await loadTicket(fixture);
  assert.equal(saved.terminalReason!.outcome, 'harness-timeout');
  assert.equal(saved.retries[keys.retryKey({ vertex: 'green', visit: 1, action: 'green', recovery: 0 })]!.timeout, 1);
});

test('a malformed response held for cleanup parse-retries on resume', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: {
        files: golden.firstVisitResponses[GREEN_CALL]!.files!,
        response: { claim: 'nonsense' },
        cleanup: UNCONFIRMED,
      },
      [GREEN_RETRY]: { files: {}, response: golden.greenResponse },
    }),
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  assert.equal(attemptsOf(fixture, 'green', 'test').length, 0);

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa');
  const nudged = fixture.harness.calls.at(-1)!;
  assert.match(nudged.brief!, /did not return a valid structured result/);
  assert.equal(nudged.resume, 'fake-session-2', 'it resumes the held Session');
});

test('a crash during a resumed completion spends its retry once', async (t) => {
  const timedOut = { status: 'timed-out' };
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: { files: {}, response: null, cleanup: UNCONFIRMED, result: timedOut },
      [GREEN_RETRY]: { files: golden.firstVisitResponses[GREEN_CALL]!.files!, response: golden.greenResponse },
    }),
  });
  await interpreter.runExecution(fixture.options);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'green', 1, 'green');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'after-completion' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const crashed = await loadTicket(fixture);
  const key = keys.retryKey({ vertex: 'green', visit: 1, action: 'green', recovery: 0 });
  assert.equal(crashed.retries[key]!.timeout, 1, 'the retry was spent with the completion');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa');
  const saved = await loadTicket(fixture);
  assert.equal(saved.retries[key]!.timeout, 1, 'and only once');
  assert.equal(fixture.harness.calls.length, 3, 'red, the held green and its one retry');
});

// While the Ticket waited, either a survivor or a human can have committed, and nothing tells them apart: red has no gg
// commit behind it for Reconciliation to compare with, so the call's own baseline finds it.
test('a commit made while a cleanup hold waits holds the Ticket and nothing is reset', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [RED_CALL]: { ...golden.firstVisitResponses[RED_CALL], cleanup: UNCONFIRMED },
    }),
  });
  await interpreter.runExecution(fixture.options);
  fixture.fakeIntegrity!.write(fixture.worktree, 'lib/add.mjs');
  fixture.fakeIntegrity!.commit(fixture.worktree);

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.held, true);
  const saved = await loadTicket(fixture);
  assert.match(saved.terminalReason!.text, /head and index changed while the Ticket waited/);
  assert.deepEqual(intents(saved, 'reset'), []);
});

test('a committed test changed while the Ticket waited fails Test Immutability on resume, and is kept', async (t) => {
  const fixture = await golden.fixture(t, {
    responses: firstVisitWith({
      [GREEN_CALL]: { ...golden.firstVisitResponses[GREEN_CALL], cleanup: UNCONFIRMED },
    }),
  });
  await interpreter.runExecution(fixture.options);
  // What a survivor wrote over red's committed test while the Ticket waited.
  writeFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'export {};\n');

  const result = await laterRun(fixture);
  assert.equal(result.held, true);
  const saved = await loadTicket(fixture);
  assert.match(saved.terminalReason!.text, /committed tests changed while the Ticket waited/);
  assert.deepEqual(intents(saved, 'reset'), []);
  assert.equal(readFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'utf8'), 'export {};\n');
  assert.equal(attemptsOf(fixture, 'green', 'test').length, 0, 'before any Check');
});

test('a crash between the hold and its comment finishes the hold on the next Run', async (t) => {
  const fixture = await heldCheck(t);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'green', 1, 'test.cleanup-comment.1');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  fixture.options.deps.exec.cleanupConfirmed = () => false;

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(holdComments(fixture).length, 1);
});

// A gate: a Visit with no agent Action, whose Check holds. The fixture's publish has one.
async function heldGate(t: Parameters<typeof golden.fixture>[0]) {
  const fixture = await golden.fixture(t);
  let held = false;
  editRuns(fixture, (run) => {
    if (held || run.code !== 0 || fixture.executionRecord.cursor.vertex !== 'publish') return run;
    held = true;
    return { ...run, cleanup: UNCONFIRMED };
  });
  return fixture;
}

test('a Check with no agent Action, held for cleanup, stands on its unchanged tree', async (t) => {
  const fixture = await heldGate(t);
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  const checks = fixture.shells.length;

  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.equal(fixture.shells.length, checks, 'its result stood');
});

test('a Check with no agent Action, held for cleanup, holds the Ticket if its tree changed', async (t) => {
  const fixture = await heldGate(t);
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.ok(saved.visitState!.firstAttemptBaseline, 'it kept what the Assertions compare with');
  fixture.fakeIntegrity!.write(fixture.worktree, 'notes.txt');

  assert.equal((await laterRun(fixture)).held, true);
  const ended = await loadTicket(fixture);
  assert.match(ended.terminalReason!.text, /tree changed while the Ticket waited/);
  assert.deepEqual(intents(ended, 'reset'), []);
});

test('re-running the Checks of a held Visit counts toward the Action Cap', async (t) => {
  const fixture = await heldCheck(t);
  // red's three Actions and green's agent call and Check.
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.actionCap = 5;
  });
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  const checks = fixture.shells.length;
  writeFileSync(join(fixture.worktree, 'notes.txt'), 'what a survivor wrote\n');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.shells.length, checks, 'no Check ran past the cap');
  assert.match((await loadTicket(fixture)).terminalReason!.text, /Action Cap of 5/);
});

for (const point of ['before-effect', 'after-effect', 'after-completion'] as const) {
  test(`a crash ${point} of a hold's release posts no second hold`, async (t) => {
    const fixture = await heldCheck(t);
    await interpreter.runExecution(fixture.options);
    const actionMarker = golden.markerOf(fixture.executionRecord, 'green', 1, 'test.cleanup-release.1');
    await assert.rejects(
      laterRun(fixture, { crashAt: { marker: actionMarker, point } }),
      (err) => err instanceof interpreter.CrashError,
    );

    assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
    assert.equal(holdComments(fixture).length, 1);
    assert.equal(fixture.gh.labels.has(CLEANUP_LABEL), false);
  });
}

test('an issue that cannot be read leaves a cleanup hold Pending', async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'view', status: 502 });

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.equal(saved.state, 'active');
  assert.deepEqual(saved.visitState!.unconfirmedCleanup, UNCONFIRMED);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa', 'the next Run goes on');
});

test('an issue unread at Reconciliation, once a hold is confirmed, leaves it to the next Run', async (t) => {
  const fixture = await heldCheck(t);
  await interpreter.runExecution(fixture.options);
  let views = 0;
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'view' && ++views === 2, status: 502 });

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal((await loadTicket(fixture)).state, 'active');
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
});

test('a Pending cleanup hold that is abandoned or held takes its Await Label down', async (t) => {
  const abandoned = await heldCheck(t);
  await interpreter.runExecution(abandoned.options);
  abandoned.options.deps.exec.cleanupConfirmed = () => false;
  abandoned.gh.labels.add('gg:state:needs-human');
  assert.equal((await laterRun(abandoned)).outcome, 'abandoned');
  assert.equal(abandoned.gh.labels.has(CLEANUP_LABEL), false);

  const held = await heldCheck(t);
  await interpreter.runExecution(held.options);
  held.fakeIntegrity!.write(held.worktree, 'notes.txt');
  held.fakeIntegrity!.commit(held.worktree);
  assert.equal((await laterRun(held)).held, true);
  assert.equal(held.gh.labels.has(CLEANUP_LABEL), false);
});

test('a run stop met while a hold finishes its report leaves the hold Pending', async (t) => {
  const fixture = await heldCheck(t);
  const comment = golden.markerOf(fixture.executionRecord, 'green', 1, 'test.cleanup-comment.1');
  fixture.gh.fail({ matches: (args) => args[0] === 'api' && args.includes('POST'), status: 502 });
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: comment, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  fixture.options.deps.exec.cleanupConfirmed = () => false;
  const runState = { stop: { failureClass: 'auth', ticket: 99 }, remoteNotBefore: 0 };

  assert.equal((await laterRun(fixture, { runState })).outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.equal(saved.state, 'active');
  assert.deepEqual(saved.visitState!.unconfirmedCleanup, UNCONFIRMED);
});
