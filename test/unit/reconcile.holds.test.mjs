import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as reconcile from '../../lib/reconcile.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from '../support/golden.mjs';
import {
  stepsOf, withMarker, loadTicket, EFFECTS, POINTS, crashed, NEEDS_HUMAN, reconcileArgs,
} from '../support/reconcile.mjs';

// Each Terminal kind crashes at its needs-human label (a fault report's Actions are fault-<effect>), then resumes on a
// freshly loaded record with the same options.
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the held needs-human label keeps the held classification`, async (t) => {
    const g = await golden.setup(t);
    // The completed commit's Vertex is gone from the Flow, so Reconciliation holds the Ticket.
    await crashed(g, EFFECTS.commit.at, 'after-completion');
    g.options.flow = structuredClone(g.flow);
    g.options.flow.ticket.vertices = { builder: g.flow.ticket.vertices.green };
    g.options.flow.ticket.entry = 'builder';
    g.options.record = await loadTicket(g);
    await crashed(g, ['needs-human', 1, 'hold-label', 0], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true);
    assert.ok(g.gh.labels.has(NEEDS_HUMAN));
    assert.equal((await loadTicket(g)).state, 'held');
    const ends = g.readEvents().filter((e) => e.type === 'ticket_end');
    assert.equal(ends.length, 1);
    assert.match(ends[0].reason.text, /Vertex green/);
  });
}

for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the fault needs-human label keeps the fault classification`, async (t) => {
    const g = await golden.setup(t);
    const run = g.harness.run;
    g.harness.run = async (call) => {
      if (call.phase === 'red') throw new Error('the harness exploded');
      return run(call);
    };
    await crashed(g, ['needs-human', 1, 'fault-label', 0], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.fault, true);
    assert.ok(g.gh.labels.has(NEEDS_HUMAN));
    assert.equal((await loadTicket(g)).state, 'fault');
    const ends = g.readEvents().filter((e) => e.type === 'ticket_end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].error, 'the harness exploded');
  });
}

for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the run stop needs-human label keeps the run stop classification`, async (t) => {
    const g = await golden.setup(t, { responses: { 'red/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } } });
    await crashed(g, ['needs-human', 1, 'end-label', 0], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.runStop?.failureClass, 'auth');
    assert.ok(g.gh.labels.has(NEEDS_HUMAN));
    assert.equal((await loadTicket(g)).state, 'needs-human');
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

test('dirtyState and humanOverride return decisions without finalizing the record', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  writeFileSync(join(g.worktree, 'human.txt'), 'mine\n');
  const before = await loadTicket(g);
  const rec = await loadTicket(g);

  assert.ok(await reconcile.dirtyState(rec, { git: g.options.git, worktree: g.worktree }), 'the human file is unknown dirty state');
  assert.equal(rec.state, 'active');
  assert.deepEqual(await loadTicket(g), before, 'the hold is only decided');
  assert.equal((await reconcile.humanOverride(rec, [NEEDS_HUMAN], 'gg'))?.next, 'abandon');
  assert.equal(rec.state, 'active');
  assert.deepEqual(await loadTicket(g), before, 'the abandonment is only decided');
});

test('a vertex missing from the flow holds the ticket', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'after-completion');
  const flow = structuredClone(g.flow);
  flow.ticket.vertices = { builder: flow.ticket.vertices.green };
  flow.ticket.entry = 'builder';

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g), flow));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason, /Vertex green/);

  await interpreter.runExecution({ ...g.options, flow, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN));
  assert.equal(g.harness.calls.length, 2);
});

const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';

// A green whose first pass fails the Green Check, so its test-fix recovery pass runs and passes.
async function testFixSetup(t) {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'green/1/green/1': { files: { 'lib/add.mjs': 'export const add = () => 0;\n' }, response: golden.greenResponse },
    'green/1/test-fix/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: golden.greenResponse } } });
  g.options.exec = {
    runShell: async (command, opts) => {
      const file = join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs');
      if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
      return readFileSync(file, 'utf8').includes('a + b')
        ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
    },
  };
  return g;
}
const greenActions = (g) => g.readEvents().filter((e) => e.type === 'action' && e.vertex === 'green').map((e) => `${e.action}/${e.recovery}`);

test('a resume after the commit of a recovery pass continues at its push', async (t) => {
  const g = await testFixSetup(t);
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: golden.markerOf(g.rec, 'green', 1, 'commit', 1), point: 'after-completion' } }), /crash/);
  const loaded = await loadTicket(g);
  assert.deepEqual([loaded.cursor.action, loaded.cursor.recovery], ['commit', 1], 'the commit inherits the recovery pass number');

  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  assert.equal(result.outcome, 'done');
  assert.equal(g.harness.calls.length, 3, 'no agent call runs again');
  assert.deepEqual(greenActions(g), ['green/0', 'test/0', 'green/1', 'test/1', 'commit/1', 'push/1', 'pr/1']);
});

test('a missing transcript starts the phase fresh', async (t) => {
  const g = await testFixSetup(t);
  // Before the test-fix Attempt's intent: one interrupted after it would be held instead.
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: golden.markerOf(g.rec, 'green', 1, 'green', 1), point: 'before-intent' } }), /crash/);
  const loaded = await loadTicket(g);
  assert.deepEqual([loaded.cursor.action, loaded.cursor.recovery], ['green', 1], 'the recovery pass');
  rmSync(loaded.sessions['green/1/green'].transcriptPath);

  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  const call = g.harness.calls[2];
  assert.equal(call.marker, golden.markerOf(loaded, 'green', 1, 'green', 1), 'the recovery pass of the green call');
  assert.equal(call.resume, null, 'the green Session is not resumed without its transcript');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT), 'the full test-fix Brief, not a nudge');
  assert.ok(g.logs.some((l) => /transcript/.test(l)), `the fresh start is logged: ${JSON.stringify(g.logs)}`);
  assert.equal(result.outcome, 'done');
  // The resume continues at the recovery pass: no first-pass Action runs again, and the Actions after it carry its number.
  assert.deepEqual(greenActions(g), ['green/0', 'test/0', 'green/1', 'test/1', 'commit/1', 'push/1', 'pr/1']);
});

test('bounds survive a restart', async (t) => {
  const review = (findings) => ({ files: {}, response: {
    claim: 'changes', summary: 'The review says changes.', dodMet: true, tddEvidenceOk: true, findings, diagnosis: '' } });
  const finding = (issue) => ({ severity: 'major', file: 'lib/add.mjs', issue, fix: 'Make it right.' });
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'reviewer/1/review/1': review([finding('first problem')]),
    'implementer-fix/1/fix/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b; // one\n' },
      response: { ...golden.greenResponse, summary: 'Address the findings.' } },
    'reviewer/2/review/1': review([finding('second problem')]) } });
  const reviewerPersona = join(g.root, 'personas', 'reviewer.md');
  writeFileSync(reviewerPersona, '# reviewer\nJudge the diff.\n');
  const { red, green } = g.flow.ticket.vertices;
  g.flow.ticket.vertices = {
    red,
    green: { ...green, then: 'reviewer' },
    reviewer: { agent: { ...structuredClone(green.agent), persona: reviewerPersona, access: 'read-only' }, procedure: 'review',
      options: {}, route: { ok: 'done', changes: { to: 'implementer-fix', max: 1, exhausted: 'needs-human' } } },
    'implementer-fix': { agent: structuredClone(green.agent), procedure: 'fix', options: {}, then: 'reviewer' },
  };
  const key = 'reviewer->implementer-fix:changes';
  const { loaded } = await crashed(g, ['reviewer', 2, 'comment', 0], 'after-completion');
  assert.equal(loaded.traversals[key], 1, 'the Edge is at its Bound');

  const before = g.harness.calls.length;
  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  assert.equal(result.outcome, 'needs-human', 'the changes Edge routes to its exhausted target');
  assert.ok(!g.harness.calls.slice(before).some((c) => c.brief.startsWith('FIX VISIT')), 'no fix call after the restart');
  const final = await loadTicket(g);
  assert.equal(final.traversals[key], 1);
  assert.deepEqual(final.visits, { red: 1, green: 1, reviewer: 2, 'implementer-fix': 1 });
});

test('a corrupt record holds the ticket', async (t) => {
  const g = await golden.setup(t);
  const corrupt = '{ "schemaVersion": 1, "log": [';
  const db = record.openDb(g.commonDir);
  db.prepare("UPDATE records SET json = ? WHERE kind = 'ticket' AND n = ?").run(corrupt, golden.TICKET);
  const err = await loadTicket(g).catch((e) => e);
  assert.ok(err instanceof record.RecordCorruptError, String(err));

  const decided = await reconcile.reconcile(reconcileArgs(g, err));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason, /corrupt/);
  const row = db.prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(golden.TICKET);
  assert.equal(row.json, corrupt, 'the corrupt record is never discarded');
});

// #66: a lookup that fails proves nothing either way. The done comment landed before the crash, so only a working
// lookup can tell.
const badGateway = () => Object.assign(new Error('gh: Bad Gateway (HTTP 502)\ngh api repos/{owner}/{repo}/issues/15/comments'),
  { code: 1, stdout: '', stderr: 'gh: Bad Gateway (HTTP 502)' });

test('a failed lookup is unknown, not absent', async (t) => {
  const g = await golden.setup(t);
  const { m, loaded } = await crashed(g, EFFECTS.comment.at, 'after-effect');
  const entry = record.openIntents(loaded).find((e) => e.marker === m);
  const down = { ...g.options.gh, issueComments: async () => { throw badGateway(); } };

  const found = await reconcile.findEffect(entry, { rec: loaded, gh: down, cwd: g.mainRoot });
  assert.equal(found.status, 'unknown');
  assert.match(found.error.message, /HTTP 502/);
  await assert.rejects(reconcile.reconcile({ ...reconcileArgs(g, loaded), gh: down }), /HTTP 502/, 'never taken for absence');
  assert.deepEqual(stepsOf(loaded, m), ['intent'], 'no evidence or completion');
  assert.equal(withMarker(g.gh.comments.map((c) => c.body), m).length, 1);
});

test('a failed lookup in a Run is retried on the Action budget and finds the landed effect', async (t) => {
  const g = await golden.setup(t);
  const { m } = await crashed(g, EFFECTS.comment.at, 'after-effect');
  let failures = 1;
  const once = { ...g.options.gh, issueComments: async (...args) => {
    if (failures-- > 0) throw badGateway();
    return g.options.gh.issueComments(...args);
  } };

  const result = await interpreter.runExecution({ ...g.options, gh: once, record: await loadTicket(g) });
  assert.equal(result.outcome, 'done', JSON.stringify(result));
  assert.equal(withMarker(g.gh.comments.map((c) => c.body), m).length, 1, 'not posted again');
  assert.deepEqual(g.sleeps, [60_000]);
  assert.deepEqual(stepsOf(await loadTicket(g), m), ['intent', 'evidence', 'complete']);
});
