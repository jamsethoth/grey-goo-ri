import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as github from '../../lib/github.mjs';
import * as integrity from '../../lib/integrity.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as locks from '../../lib/locks.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, fixture, seedExecution, markerOf, ticketResult, failComment,
  endsOf, loadTicket, dirtyTicket, failHoldLabel,
} from '../support/run.mjs';

test('a hold label failure leaves its label intent open for the next Run', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const failing = failHoldLabel(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET), 'the label failure is an Event');
  const mid = await loadTicket(f);
  assert.equal(mid?.terminalStop?.held, true, 'the hold is decided');
  assert.notEqual(mid.state, 'held', 'a hold whose label is pending is not held');
  assert.deepEqual(record.openIntents(mid).map((e) => e.action), ['label'], 'the label intent stays open');
  assert.equal(endsOf(f, mid.execution).length, 0);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is reused');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the hold labels land: ${[...f.gh.labels]}`);
  const final = await loadTicket(f);
  assert.equal(final.execution, mid.execution);
  assert.deepEqual(record.openIntents(final), []);
  assert.equal(final.state, 'held');
  assert.equal(endsOf(f, final.execution).length, 1);
});

test('a seeded hold label failure is finished on the next Run', async (t) => {
  const { f, seededRec } = await dirtyTicket(t, true);
  const failing = failHoldLabel(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET), 'the label failure is an Event');
  const mid = await loadTicket(f);
  assert.equal(mid?.terminalStop?.held, true, 'the hold is decided');
  assert.notEqual(mid.state, 'held', 'a hold whose label is pending is not held');
  assert.deepEqual(record.openIntents(mid).map((e) => e.action), ['commit', 'label'], 'the label intent stays open beside the seeded commit');
  assert.equal(endsOf(f, mid.execution).length, 0);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is reused');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the hold labels land: ${[...f.gh.labels]}`);
  const final = await loadTicket(f);
  assert.equal(final.execution, mid.execution);
  assert.deepEqual(record.openIntents(final), record.openIntents(seededRec), 'only the seeded commit stays open');
  assert.equal(final.state, 'held');
  assert.equal(endsOf(f, final.execution).length, 1);
});

// A seeded dirty Ticket whose hold comment failed, under a human needs-human label, with every label edit recording
// whether the record was abandoned first and failing while `cleanup.fails` is set.
async function overriddenPendingHold(t) {
  const { f, seededRec } = await dirtyTicket(t, true);
  const before = await integrity.snapshot(f.worktree, f.options.git);
  const failing = failComment(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  const [holdComment] = record.openIntents(mid).filter((e) => e.action === 'comment');
  failing.on = false;
  f.gh.labels.add(NEEDS_HUMAN);
  const inner = f.gh.gh;
  const states = [];
  const cleanup = { fails: false };
  github.setGh(async (args, cwd, input) => {
    if (args[0] === 'issue' && args[1] === 'edit') {
      states.push((await loadTicket(f)).terminalStop?.abandoned);
      if (cleanup.fails) {
        f.gh.calls.push({ args, cwd, input });
        throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
      }
    }
    return inner(args, cwd, input);
  });
  return { f, seededRec, before, mid, holdComment, states, cleanup };
}

test('human override abandons a pending hold before any label cleanup', async (t) => {
  const { f, seededRec, before, holdComment, states } = await overriddenPendingHold(t);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'abandoned');
  assert.deepEqual(states, [true], 'abandoned before the label cleanup');
  assert.deepEqual(f.comments(), [], 'the pending hold comment is not replayed');
  assert.deepEqual(f.labelAdds(), [], 'no label is added');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the human hold remains: ${[...f.gh.labels]}`);
  const final = await loadTicket(f);
  assert.equal(final.state, 'abandoned');
  assert.match(final.terminalReason.text, /needs-human/);
  const ends = endsOf(f, final.execution);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].outcome, 'abandoned');
  assert.deepEqual(ends[0].reason, final.terminalReason);
  assert.ok(record.openIntents(final).some((e) => e.marker === holdComment.marker), 'the hold comment intent stays open, never replayed');
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seededRec), 'the older intent is kept');
  assert.deepEqual(final.log.filter((e) => e.step === 'intent' && e.action === 'label').map((e) => e.payload),
    [{ ticket: TICKET, add: [], remove: [IN_PROGRESS] }], 'the cleanup is one write-ahead label Action');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('human override of a pending hold is decided durably when its label cleanup fails, and lands on the next Run', async (t) => {
  const { f, seededRec, before, mid, holdComment, states, cleanup } = await overriddenPendingHold(t);
  cleanup.fails = true;

  const failed = await run.runTarget(f.options);
  assert.equal(run.runExitCode(failed), 1, JSON.stringify(failed));
  const pending = await loadTicket(f);
  assert.equal(pending.terminalStop?.abandoned, true, 'the abandonment is decided durably');
  assert.equal(pending.state, 'active', 'its final state lands with ticket_end');
  assert.equal(endsOf(f, mid.execution).length, 0, 'the abandonment has not landed');

  cleanup.fails = false;
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'abandoned');
  assert.deepEqual(states, [true, true], 'abandoned before every label cleanup');
  assert.deepEqual(f.comments(), [], 'the pending hold comment is not replayed');
  assert.deepEqual(f.labelAdds(), [], 'no label is added');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the human hold remains: ${[...f.gh.labels]}`);
  const final = await loadTicket(f);
  assert.equal(final.state, 'abandoned');
  assert.match(final.terminalReason.text, /needs-human/);
  const ends = endsOf(f, final.execution);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].outcome, 'abandoned');
  assert.deepEqual(ends[0].reason, final.terminalReason);
  assert.ok(record.openIntents(final).some((e) => e.marker === holdComment.marker), 'the hold comment intent stays open, never replayed');
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seededRec), 'the older intent is kept');
  assert.deepEqual(final.log.filter((e) => e.step === 'intent' && e.action === 'label').map((e) => e.payload),
    [{ ticket: TICKET, add: [], remove: [IN_PROGRESS] }], 'the cleanup is one write-ahead label Action');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('a pending fault report whose comment lookup fails stays pending and posts no second comment', async (t) => {
  const f = fixture(t);
  f.options.git = { ...f.options.git, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };
  const inner = f.gh.gh;
  let mode = 'crash';
  github.setGh(async (args, cwd, input) => {
    if (mode === 'crash' && golden.isCommentPost(args)) {
      await inner(args, cwd, input);
      throw new interpreter.CrashError('crash after the fault comment landed');
    }
    if (mode === 'lookup' && args[0] === 'api' && /issues\/\d+\/comments$/.test(args.at(-1))) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    }
    return inner(args, cwd, input);
  });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  const [open] = record.openIntents(mid ?? { log: [] }).filter((e) => e.action === 'comment');
  assert.ok(open, 'the landed fault comment waits for its completion');
  assert.equal(f.comments().length, 1);

  mode = 'lookup';
  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 1, JSON.stringify(second));
  assert.match(ticketResult(second).error, /HTTP 502/);
  assert.equal(f.comments().length, 1, 'the stored payload is not posted again');
  const still = await loadTicket(f);
  assert.deepEqual(still.terminalReason, mid.terminalReason, 'the fault keeps its Terminal Reason');
  assert.deepEqual(still.terminalStop, mid.terminalStop);
  assert.equal(endsOf(f, mid.execution).length, 0, 'the fault stays pending');

  mode = null;
  const third = await run.runTarget(f.options);
  assert.equal(run.runExitCode(third), 1, 'a fault exits 1');
  assert.equal(f.comments().length, 1, 'the marker found the landed comment');
  const final = await loadTicket(f);
  assert.deepEqual(final.log.filter((e) => e.marker === open.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'fault');
  assert.equal(endsOf(f, final.execution).length, 1);
  assert.match(endsOf(f, final.execution)[0].error, /disk full/);
});

test('a Terminal saved before ticket_end resumes finalization exactly once', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const restore = golden.failAppends(t, (event) => event.type === 'ticket_end');
  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = await loadTicket(f);
  assert.equal(mid?.state, 'active', 'the final state rolled back with its ticket_end');
  assert.equal(mid.terminalStop?.held, true, 'the decided hold waits for the next Run');
  assert.equal(endsOf(f, mid.execution).length, 0);
  restore();
  const effects = () => f.gh.calls.filter((c) => golden.isCommentPost(c.args) || (c.args[0] === 'issue' && c.args[1] === 'edit')).length;
  const done = effects();

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2);
  assert.equal(ticketResult(second).outcome, 'needs-human', 'not skipped as finished');
  assert.equal(effects(), done, 'no GitHub effect is repeated');
  assert.equal(endsOf(f, mid.execution).length, 1);
  assert.equal(f.comments().length, 1);
});

test('a crash between admission and its hold keeps the decision and its one ticket_start', async (t) => {
  const { f } = await dirtyTicket(t, false);
  // Every update carrying a Terminal stop fails, as if gg died once admission had saved the new record.
  const restore = golden.failSaves(t, (saved, next) => saved !== undefined && next.terminalStop !== undefined);
  const first = await run.runTarget(f.options);
  restore();
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = await loadTicket(f);
  assert.ok(mid, 'admission saved the record');
  assert.equal(mid.terminalStop, undefined, 'the hold was never saved');
  assert.equal(f.comments().length, 0);

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const starts = f.readEvents().filter((e) => e.type === 'ticket_start' && e.ticket === TICKET);
  assert.deepEqual(starts.map((e) => e.execution), [mid.execution], 'one ticket_start for the Execution');
  const final = await loadTicket(f);
  assert.equal(final.state, 'held');
  assert.equal(final.terminalStop.fresh, true, 'the hold is still the fresh one admission decided');
  const [comment, ...more] = f.comments();
  assert.equal(more.length, 0);
  assert.doesNotMatch(comment, /DELETE FROM records/, 'a fresh hold has no row to delete');
  assert.equal(endsOf(f, mid.execution).length, 1);
});

test('an Interrupted Attempt hold warns before its record is deleted, then and on the next Run', async (t) => {
  const responses = { ...golden.firstVisitResponses, 'implementer/1/red/1': { throw: new interpreter.CrashError('gg died during the call') } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  await seedExecution(f);
  const warning = /including ignored Protected Files\. Check them[^]*before deleting the record/;

  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 2, JSON.stringify(first));
  assert.equal((await loadTicket(f)).state, 'held');
  assert.match(f.comments().at(-1) ?? '', warning, 'the hold comment warns');

  await run.runTarget(f.options);
  const skipped = f.logs.findLast((l) => l.includes('skipped')) ?? '';
  assert.match(skipped, warning, 'the held-record skip warns too');
  assert.ok(skipped.search(warning) < skipped.indexOf('DELETE FROM records'), `the warning comes before the delete: ${skipped}`);
});

// An Execution saved before its first Visit, under a human needs-human label.
async function overriddenBeforeFirstVisit(t) {
  const f = fixture(t, { labels: [IN_PROGRESS, NEEDS_HUMAN] });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
  return f;
}

test('a human needs-human label before the first Visit prevents admission effects', async (t) => {
  const f = await overriddenBeforeFirstVisit(t);
  const before = await integrity.snapshot(f.worktree, f.options.git);

  const results = await run.runTarget(f.options);
  assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
  assert.equal(run.runExitCode(results), 2, 'a human needs-human label exits 2');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view'], ['issue', 'edit']], 'only the in-progress label is removed');
  assert.deepEqual([...f.gh.labels], [NEEDS_HUMAN], 'the human hold remains without in-progress');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  const final = await loadTicket(f);
  assert.equal(final.state, 'abandoned', 'the label overrides the record before any Visit');
  assert.deepEqual(final.visits, {});
  assert.deepEqual(final.log.map((e) => `${e.step} ${e.action}`), ['intent label', 'evidence label', 'complete label'],
    'the cleanup is one write-ahead Action');
  assert.deepEqual(final.log[0].payload, { ticket: TICKET, add: [], remove: [IN_PROGRESS] });
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => e.type), ['ticket_start', 'action', 'ticket_end']);
  assert.equal(evs.at(-1).outcome, 'abandoned');
  assert.deepEqual(evs.at(-1).reason, final.terminalReason);
});

test('a human needs-human label before the first Visit prevents admission effects in a dirty worktree', async (t) => {
  const f = await overriddenBeforeFirstVisit(t);
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  const before = await integrity.snapshot(f.worktree, f.options.git);

  const results = await run.runTarget(f.options);
  assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
  assert.equal(run.runExitCode(results), 2, 'a human needs-human label exits 2');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view'], ['issue', 'edit']], 'only the in-progress label is removed');
  assert.deepEqual([...f.gh.labels], [NEEDS_HUMAN], 'the human hold remains without in-progress');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n');
  const final = await loadTicket(f);
  assert.equal(final.state, 'abandoned', 'the label overrides the record before any Visit');
  assert.deepEqual(final.visits, {});
  assert.deepEqual(final.log.map((e) => `${e.step} ${e.action}`), ['intent label', 'evidence label', 'complete label'],
    'the cleanup is one write-ahead Action');
  assert.deepEqual(final.log[0].payload, { ticket: TICKET, add: [], remove: [IN_PROGRESS] });
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => e.type), ['ticket_start', 'action', 'ticket_end']);
  assert.equal(evs.at(-1).outcome, 'abandoned');
  assert.deepEqual(evs.at(-1).reason, final.terminalReason);
});

test('a human needs-human label prevents admission effects without a record', async (t) => {
  const f = fixture(t, { labels: [NEEDS_HUMAN] });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'needs-human exits 2 without a record');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
  assert.equal(f.worktrees(), 1, 'no worktree created');
  assert.equal(f.loadRow(), undefined, 'no record is written');
});

test('a human needs-human label prevents admission effects with a corrupt record', async (t) => {
  const f = fixture(t, { labels: [NEEDS_HUMAN] });
  record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{');

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'needs-human exits 2 even without a readable record');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
  assert.equal(f.worktrees(), 1, 'no worktree created');
  assert.equal(f.loadRow(), '{', 'the record is untouched');
});

// GitHub matches label names case-insensitively, so a human's own spelling of a State Label is still that label.
const HUMAN_NEEDS_HUMAN = 'GG:State:Needs-Human';
const SHOUTED_IN_PROGRESS = 'GG:STATE:IN-PROGRESS';

const MIXED_CASE = [
  { labels: [HUMAN_NEEDS_HUMAN, SHOUTED_IN_PROGRESS], edits: [['--remove-label', IN_PROGRESS]], states: [true] },
  { labels: [HUMAN_NEEDS_HUMAN, IN_PROGRESS], edits: [['--remove-label', IN_PROGRESS]], states: [true] },
  { labels: [HUMAN_NEEDS_HUMAN], edits: [], states: [] },
];
for (const { labels, edits, states: expectedStates } of MIXED_CASE) {
  test(`mixed-case human needs-human wins before any label write: ${labels.join(', ')}`, async (t) => {
    const f = fixture(t, { labels });
    await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    const inner = f.gh.gh;
    const states = [];
    github.setGh(async (args, cwd, input) => {
      if (args[0] === 'issue' && args[1] === 'edit') states.push((await loadTicket(f)).terminalStop?.abandoned);
      return inner(args, cwd, input);
    });

    const results = await run.runTarget(f.options);
    assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
    assert.equal(run.runExitCode(results), 2);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(f.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').map((c) => c.args.slice(3)), edits,
      'only the in-progress label is removed');
    assert.deepEqual(states, expectedStates, 'the record is abandoned before the label write');
    assert.deepEqual(f.comments(), [], 'no comment posted');
    assert.deepEqual([...f.gh.labels], [HUMAN_NEEDS_HUMAN], 'the human hold keeps its spelling');
    assert.equal((await loadTicket(f)).state, 'abandoned');
  });
}

test('mixed-case needs-human skips without a record', async (t) => {
  const f = fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  const results = await run.runTarget(f.options);
  assert.equal(ticketResult(results).outcome, 'skipped', JSON.stringify(results));
  assert.equal(ticketResult(results).state, 'needs-human');
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
  assert.equal(f.worktrees(), 1, 'no worktree created');
  assert.equal(f.loadRow(), undefined, 'no record is written');
});

test('mixed-case needs-human skips with a corrupt record', async (t) => {
  const f = fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{');
  const results = await run.runTarget(f.options);
  assert.equal(ticketResult(results).outcome, 'skipped', JSON.stringify(results));
  assert.equal(ticketResult(results).state, 'needs-human');
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
  assert.equal(f.worktrees(), 1, 'no worktree created');
  assert.equal(f.loadRow(), '{', 'the record is untouched');
});

test('mixed-case needs-human skips with a held ticket lock', async (t) => {
  const f = fixture(t, { labels: [HUMAN_NEEDS_HUMAN] });
  // Another connection holds the lock, as another gg process would.
  const holder = await locks.tryAcquire(f.commonDir, `ticket-${TICKET}`);
  let results;
  try {
    results = await run.runTarget(f.options);
  } finally {
    await locks.release(holder);
  }
  assert.equal(ticketResult(results).outcome, 'skipped', JSON.stringify(results));
  assert.equal(ticketResult(results).state, 'needs-human');
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
  assert.equal(f.worktrees(), 1, 'no worktree created');
  assert.equal(f.loadRow(), undefined, 'no record is written');
});

test('admission does not re-add differently cased in-progress', async (t) => {
  const f = fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  f.options.config.labelPrefix = 'Gg';
  await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'the Execution resumes at its cursor');
  assert.equal((await loadTicket(f)).state, 'done');
  assert.deepEqual(f.labelAdds(), ['Gg:state:ready-for-qa'], 'in-progress is not added again');
  assert.ok(![...f.gh.labels].some((l) => l.toLowerCase() === IN_PROGRESS), `the Terminal removes it: ${[...f.gh.labels]}`);
});

test('a differently cased in-progress without a record is left for Stuck handling', async (t) => {
  const f = fixture(t, { labels: [SHOUTED_IN_PROGRESS] });
  f.options.config.labelPrefix = 'Gg';
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
  assert.ok(f.logs.some((l) => l.includes('with no Execution Record behind it')), JSON.stringify(f.logs));
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no write on a Stuck Ticket');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.ok(f.gh.labels.has(SHOUTED_IN_PROGRESS), 'the State Label is left for Stuck handling');
});

test('an interrupted reset under a human needs-human label is abandoned before anything is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [NEEDS_HUMAN] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...f.options.git, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  f.options.exec = exec;

  await run.runTarget(f.options);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), "the agent's changes are kept for the human");
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'abandoned', 'the label overrides the record');
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.comments(), [], 'no comment posted');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

const NOT_READY = [{ blockedBy: [{ number: 3, state: 'OPEN' }] }, { state: 'CLOSED' }];
for (const issue of NOT_READY) {
  test(`a resumed execution still needs its ticket open and unblocked: ${JSON.stringify(issue)}`, async (t) => {
    const f = fixture(t, { labels: [IN_PROGRESS], issue });
    await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
    const row = f.loadRow();
    await run.runTarget(f.options);
    assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
    assert.equal(f.loadRow(), row, 'the record is not resumed');
    assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /not ready/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  });
}
