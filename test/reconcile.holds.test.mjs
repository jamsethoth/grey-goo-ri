import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as reconcile from '../lib/reconcile.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';
import {
  markerOf, stepsOf, withMarker, loadTicket, EFFECTS, POINTS, crashed, NEEDS_HUMAN, reconcileArgs,
} from './support/reconcile.mjs';

// Each Terminal kind crashes at its needs-human label (a fault report's Actions have phase fault), then resumes on a freshly loaded record with the same options.
const CLASSIFIED = {
  held: {
    phase: 'hold',
    async crash(g) {
      await crashed(g, EFFECTS.commit.at, 'after-completion');
      g.options.flow = structuredClone(g.flow);
      g.options.flow.ticket.vertices = { builder: g.flow.ticket.vertices.implementer };
      g.options.flow.ticket.entry = 'builder';
      g.options.record = await loadTicket(g);
    },
    check(result, final, end) {
      assert.equal(result.held, true);
      assert.equal(final.state, 'held');
      assert.match(end.reason.text, /implementer/);
    },
  },
  fault: {
    phase: 'fault',
    async crash(g) {
      const run = g.harness.run;
      g.harness.run = async (call) => {
        if (call.phase === 'red') throw new Error('the harness exploded');
        return run(call);
      };
    },
    check(result, final, end) {
      assert.equal(result.fault, true);
      assert.equal(final.state, 'fault');
      assert.equal(end.error, 'the harness exploded');
    },
  },
  'run stop': {
    responses: { 'implementer/1/red/1': { files: {}, response: null, failure: { class: 'auth' } } },
    async crash() {},
    check(result, final) {
      assert.equal(result.runStop?.failureClass, 'auth');
      assert.equal(final.state, 'needs-human');
    },
  },
};
for (const [kind, c] of Object.entries(CLASSIFIED)) {
  for (const point of Object.keys(POINTS)) {
    test(`a crash ${point} of the ${kind} needs-human label keeps the ${kind} classification`, async (t) => {
      const g = await golden.setup(t, c.responses && { responses: c.responses });
      await c.crash(g);
      await crashed(g, ['needs-human', 1, c.phase ?? 'needs-human', 2], point);

      const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
      assert.equal(result.outcome, 'needs-human');
      assert.ok(g.gh.labels.has(NEEDS_HUMAN));
      const ends = g.readEvents().filter((e) => e.type === 'ticket_end');
      assert.equal(ends.length, 1);
      c.check(result, await loadTicket(g), ends[0]);
    });
  }
}

test('a needs-human label overrides a mid-action record', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  g.gh.labels.add(NEEDS_HUMAN);
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'abandon');
  assert.equal((await loadTicket(g)).state, 'active', 'Reconciliation only decides the abandonment');

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'abandoned');
  assert.equal(g.harness.calls.length, 2, 'the Execution is not resumed');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'the intended commit is not made');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.equal(g.gh.pr(), null);
});

test('dirtyState and humanOverride return decisions without finalizing the record', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  writeFileSync(join(g.worktree, 'human.txt'), 'mine\n');
  const row = () => record.openDb(g.commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(golden.TICKET).json;
  const before = row();
  const rec = await loadTicket(g);

  assert.ok(await reconcile.dirtyState(rec, { git: g.options.git, worktree: g.worktree }), 'the human file is unknown dirty state');
  assert.equal(rec.state, 'active');
  assert.equal(row(), before, 'the hold is only decided');
  assert.equal((await reconcile.humanOverride(rec, [NEEDS_HUMAN], 'gg'))?.next, 'abandon');
  assert.equal(rec.state, 'active');
  assert.equal(row(), before, 'the abandonment is only decided');
});

test('dirtyState lists a non-ASCII untracked name verbatim', async (t) => {
  const g = await golden.setup(t);
  golden.sh(g.worktree, 'config', 'core.quotePath', 'true');
  writeFileSync(join(g.worktree, 'café notes.txt'), 'mine\n');
  const { stat } = await reconcile.dirtyState(null, { git: g.options.git, worktree: g.worktree });
  assert.ok(stat.includes(' café notes.txt (untracked)\n'), stat);
});

// Reconciliation holds a moved branch; the hold's comment then crashes. Any git call on resume would replay or check the
// older commit, which a hold only reports.
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of a hold comment resumes its reporting Actions without replaying an older commit`, async (t) => {
    const g = await golden.setup(t);
    await crashed(g, EFFECTS.commit.at, 'before-effect');
    golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
    const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
    const hold = markerOf(g.rec, 'needs-human', 1, 'hold', 1);
    await assert.rejects(interpreter.runExecution({ ...g.options, record: await loadTicket(g), crashAt: { marker: hold, point } }),
      (err) => err instanceof interpreter.CrashError);
    const mid = await loadTicket(g);
    const older = record.openIntents(mid).filter((e) => e.action === 'commit');
    assert.equal(older.length, 1);
    const git = new Proxy({}, { get: (_, verb) => () => { throw new Error(`git ${String(verb)} called`); } });

    const result = await interpreter.runExecution({ ...g.options, git, record: mid });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(result.held, true, JSON.stringify(result));
    const final = await loadTicket(g);
    assert.equal(final.state, 'held');
    assert.deepEqual(record.openIntents(final), older, 'only the older commit intent stays open, untouched');
    assert.equal(withMarker(g.gh.comments.map((c) => c.body), hold).length, 1, 'the hold comment is posted once');
    assert.ok(g.gh.labels.has(NEEDS_HUMAN));
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
    assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.equal(g.harness.calls.length, 2);
  });
}

test('a hold report never looks up an older open PR-comment intent', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'before-effect');
  // An earlier review comment on the PR crashed before its completion.
  const older = markerOf(g.rec, 'reviewer', 1, 'review', 4);
  await record.intent(await loadTicket(g), older, 'comment', { target: { kind: 'pr', number: 7 }, body: 'x', bodyHash: 'h' });
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const hold = markerOf(g.rec, 'needs-human', 1, 'hold', 1);
  await assert.rejects(interpreter.runExecution({ ...g.options, record: await loadTicket(g), crashAt: { marker: hold, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError);
  let looked = 0;
  const gh = { ...g.options.gh, prComments: async () => { looked++; throw new Error('gh api exited 1\nHTTP 502: Bad Gateway'); } };

  const result = await interpreter.runExecution({ ...g.options, gh, record: await loadTicket(g) });
  assert.equal(looked, 0, "the older PR's comments are never read");
  assert.equal(result.held, true, JSON.stringify(result));
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(record.openIntents(final).some((e) => e.marker === older), 'the older intent stays open, untouched');
  assert.equal(withMarker(g.gh.comments.map((c) => c.body), hold).length, 1);
  assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
});

test('a vertex missing from the flow holds the ticket', async (t) => {
  const g = await golden.setup(t);
  await crashed(g, EFFECTS.commit.at, 'after-completion');
  const flow = structuredClone(g.flow);
  flow.ticket.vertices = { builder: flow.ticket.vertices.implementer };
  flow.ticket.entry = 'builder';

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g), flow));
  assert.equal(decided.next, 'hold');
  assert.match(decided.reason, /implementer/);

  await interpreter.runExecution({ ...g.options, flow, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN));
  assert.equal(g.harness.calls.length, 2);
});

const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';

test('a missing transcript starts the phase fresh', async (t) => {
  const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
    'implementer/1/green/1': { files: { 'lib/add.mjs': 'export const add = () => 0;\n' }, response: golden.greenResponse },
    'implementer/1/test-fix/1': { files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' }, response: golden.greenResponse } } });
  g.options.exec = {
    runShell: async (command, opts) => {
      const file = join(opts?.cwd ?? g.worktree, 'lib', 'add.mjs');
      if (!existsSync(file)) return { code: 1, output: golden.RED_OUTPUT, timedOut: false };
      return readFileSync(file, 'utf8').includes('a + b')
        ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: GREEN_FAIL_OUTPUT, timedOut: false };
    },
  };
  // Before the test-fix Attempt's intent: one interrupted after it would be held instead.
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: markerOf(g.rec, 'implementer', 1, 'test-fix', 1), point: 'before-intent' } }), /crash/);
  const loaded = await loadTicket(g);
  assert.equal(loaded.cursor.phase, 'test-fix');
  rmSync(loaded.sessions['implementer/1/green'].transcriptPath);

  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  const call = g.harness.calls[2];
  assert.ok(call.marker.includes(':test-fix:'), call.marker);
  assert.equal(call.resume, null, 'the green Session is not resumed without its transcript');
  assert.ok(call.brief.includes(GREEN_FAIL_OUTPUT), 'the full test-fix Brief, not a nudge');
  assert.ok(g.logs.some((l) => /transcript/.test(l)), `the fresh start is logged: ${JSON.stringify(g.logs)}`);
  assert.equal(result.outcome, 'done');
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
  const implementer = g.flow.ticket.vertices.implementer;
  g.flow.ticket.vertices = {
    implementer: { ...implementer, then: 'reviewer' },
    reviewer: { agent: { ...structuredClone(implementer.agent), persona: reviewerPersona, access: 'read-only' }, procedure: 'review',
      options: {}, route: { ok: 'done', changes: { to: 'implementer-fix', max: 1, exhausted: 'needs-human' } } },
    'implementer-fix': { agent: structuredClone(implementer.agent), procedure: 'fix', options: {}, then: 'reviewer' },
  };
  const key = 'reviewer->implementer-fix:changes';
  const { loaded } = await crashed(g, ['reviewer', 2, 'review', 3], 'after-completion');
  assert.equal(loaded.traversals[key], 1, 'the Edge is at its Bound');

  const before = g.harness.calls.length;
  const result = await interpreter.runExecution({ ...g.options, record: loaded });
  assert.equal(result.outcome, 'needs-human', 'the changes Edge routes to its exhausted target');
  assert.ok(!g.harness.calls.slice(before).some((c) => c.brief.startsWith('FIX ROUND')), 'no fix call after the restart');
  const final = await loadTicket(g);
  assert.equal(final.traversals[key], 1);
  assert.deepEqual(final.visits, { implementer: 1, reviewer: 2, 'implementer-fix': 1 });
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

// #66: a lookup that fails proves nothing either way.
test('a failed lookup is unknown, not absent', async (t) => {
  const g = await golden.setup(t);
  // The done comment landed before the crash, so only a working lookup can tell.
  const { m, loaded } = await crashed(g, EFFECTS.comment.at, 'after-effect');
  const entry = record.openIntents(loaded).find((e) => e.marker === m);
  const badGateway = () => Object.assign(new Error('gh: Bad Gateway (HTTP 502)\ngh api repos/{owner}/{repo}/issues/15/comments'),
    { code: 1, stdout: '', stderr: 'gh: Bad Gateway (HTTP 502)' });
  const down = { ...g.options.gh, issueComments: async () => { throw badGateway(); } };

  const found = await reconcile.findEffect(entry, { rec: loaded, gh: down, cwd: g.mainRoot });
  assert.equal(found.status, 'unknown');
  assert.match(found.error.message, /HTTP 502/);
  await assert.rejects(reconcile.reconcile({ ...reconcileArgs(g, loaded), gh: down }), /HTTP 502/, 'never taken for absence');
  assert.deepEqual(stepsOf(loaded, m), ['intent'], 'no evidence or completion');
  const posted = () => withMarker(g.gh.comments.map((c) => c.body), m).length;
  assert.equal(posted(), 1);

  // In a Run the failed lookup is retried on the Action's budget, and finds the landed comment.
  let failures = 1;
  const once = { ...g.options.gh, issueComments: async (...args) => {
    if (failures-- > 0) throw badGateway();
    return g.options.gh.issueComments(...args);
  } };
  const result = await interpreter.runExecution({ ...g.options, gh: once, record: await loadTicket(g) });
  assert.equal(result.outcome, 'done', JSON.stringify(result));
  assert.equal(posted(), 1, 'not posted again');
  assert.deepEqual(g.sleeps, [60_000]);
  assert.deepEqual(stepsOf(await loadTicket(g), m), ['intent', 'evidence', 'complete']);
});
