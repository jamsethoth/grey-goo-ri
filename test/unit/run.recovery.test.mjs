import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.mjs';
import * as marker from '../../lib/marker.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, fixture, seedExecution, markerOf, ticketResult, failComment,
  endsOf, lastRun, loadTicket, dirtyTicket,
} from '../support/run.mjs';

test('an admission failure on an active execution is reported as a fault', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'green', 1, 'green', 4), point: 'before-effect' }) });
  let adds = 0;
  f.options.git = { ...f.options.git, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full') } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
  assert.match(ticketResult(results).error, /disk full/);
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'fault', 'the record is marked, so it is not retried');
  assert.equal(final.execution, seeded.execution);
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'push'), record.openIntents(seeded), 'the earlier intent is kept');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('disk full')), `a comment carries the error: ${JSON.stringify(f.comments())}`);
  assert.match(f.readEvents().find((e) => e.type === 'ticket_end' && e.ticket === TICKET).error, /disk full/);
  assert.ok(f.readEvents().some((e) => e.type === 'ticket_start' && e.run === lastRun(f) && e.execution === seeded.execution));

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is not retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
});

test('a dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const before = await integrity.snapshot(f.worktree, f.options.git);
  const head = await f.options.git.headSha(f.worktree);
  const failing = failComment(f);

  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  assert.match(ticketResult(first).error, /HTTP 502/);
  const mid = await loadTicket(f);
  assert.equal(mid?.terminalReason?.decidedBy.hold, 'dirty-worktree', 'the hold is decided durably');
  assert.equal(mid.cursor.vertex, 'needs-human');
  assert.equal(mid.terminalStop?.held, true);
  assert.notEqual(mid.state, 'held', 'a hold whose comment is pending is not held');
  assert.deepEqual(record.openIntents(mid).map((e) => e.action), ['comment'], 'only the hold comment intent stays open');
  assert.deepEqual(f.comments(), []);
  assert.equal(endsOf(f, mid.execution).length, 0, 'the hold has not landed');
  assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);
  assert.equal(f.gh.labels.has(IN_PROGRESS), false);

  failing.on = false;
  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const final = await loadTicket(f);
  const [open] = record.openIntents(mid);
  assert.equal(final.execution, mid.execution);
  assert.equal(final.state, 'held');
  assert.equal(f.comments().length, 1, 'exactly one hold comment');
  assert.ok(f.comments()[0].includes(marker.markerComment(open.marker)), 'the comment carries the original Action Marker');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the hold labels land: ${[...f.gh.labels]}`);
  assert.deepEqual(record.openIntents(final), []);
  const ends = endsOf(f, final.execution);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].reason, mid.terminalReason);
  assert.equal(ends[0].run, lastRun(f));
  assert.equal(f.harness.calls.length, 0, 'no agent ran');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  assert.equal(await f.options.git.headSha(f.worktree), head, 'nothing was committed or reset');
  assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
  assert.equal(await f.options.git.remoteSha(f.mainRoot, BRANCH), null, 'nothing was pushed');
});

test('a seeded dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  const { f, seededRec } = await dirtyTicket(t, true);
  const before = await integrity.snapshot(f.worktree, f.options.git);
  const head = await f.options.git.headSha(f.worktree);
  const failing = failComment(f);

  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  assert.match(ticketResult(first).error, /HTTP 502/);
  const mid = await loadTicket(f);
  assert.equal(mid?.terminalReason?.decidedBy.hold, 'dirty-worktree', 'the hold is decided durably');
  assert.equal(mid.cursor.vertex, 'needs-human');
  assert.equal(mid.terminalStop?.held, true);
  assert.notEqual(mid.state, 'held', 'a hold whose comment is pending is not held');
  assert.deepEqual(record.openIntents(mid).map((e) => e.action), ['commit', 'comment'], 'the hold comment intent stays open beside the seeded commit');
  assert.deepEqual(record.openIntents(mid).filter((e) => e.action === 'commit'), record.openIntents(seededRec), 'older intents are unchanged');
  assert.deepEqual(f.comments(), []);
  assert.equal(endsOf(f, mid.execution).length, 0, 'the hold has not landed');
  assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);
  assert.equal(f.gh.labels.has(IN_PROGRESS), true, 'a seeded in-progress label is kept until the hold lands');

  failing.on = false;
  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const final = await loadTicket(f);
  const [open] = record.openIntents(mid).filter((e) => e.action === 'comment');
  assert.equal(final.execution, mid.execution);
  assert.equal(final.state, 'held');
  assert.equal(f.comments().length, 1, 'exactly one hold comment');
  assert.ok(f.comments()[0].includes(marker.markerComment(open.marker)), 'the comment carries the original Action Marker');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), `the hold labels land: ${[...f.gh.labels]}`);
  assert.deepEqual(record.openIntents(final), record.openIntents(seededRec), 'only the seeded commit stays open');
  const ends = endsOf(f, final.execution);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].reason, mid.terminalReason);
  assert.equal(ends[0].run, lastRun(f));
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.deepEqual(await integrity.snapshot(f.worktree, f.options.git), before, 'the worktree is untouched');
  assert.equal(await f.options.git.headSha(f.worktree), head, 'nothing was committed or reset');
  assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
  assert.equal(await f.options.git.remoteSha(f.mainRoot, BRANCH), null, 'nothing was pushed');
});

test('a resumed pending report emits no second ticket_start', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const failing = failComment(f);
  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  failing.on = false;

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
  const { execution } = await loadTicket(f);
  assert.equal(f.readEvents().filter((e) => e.type === 'ticket_start' && e.execution === execution).length, 1);
  assert.equal(endsOf(f, execution).length, 1);
});

test('fixing the worktree while a hold comment is pending still finishes the hold, and a fresh hold restarts', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const failing = failComment(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  failing.on = false;
  rmSync(join(f.worktree, 'human.txt'));

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'the pending hold finishes, not the Ticket');
  const held = await loadTicket(f);
  assert.equal(held.execution, mid?.execution);
  assert.equal(held.state, 'held');
  assert.equal(f.comments().length, 1);
  assert.equal(endsOf(f, held.execution).length, 1);
  assert.equal(f.harness.calls.length, 0, 'no agent ran');

  f.gh.labels.delete(NEEDS_HUMAN);
  const third = await run.runTarget(f.options);
  assert.equal(run.runExitCode(third), 0, JSON.stringify(third));
  assert.notEqual((await loadTicket(f)).execution, mid.execution, 'a fresh hold restarts as a new Execution');
  assert.equal(f.harness.calls.length, 2);
});

test('fixing the worktree while a hold comment is pending still finishes the hold, and a seeded hold stays held', async (t) => {
  const { f } = await dirtyTicket(t, true);
  const failing = failComment(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  failing.on = false;
  rmSync(join(f.worktree, 'human.txt'));

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'the pending hold finishes, not the Ticket');
  const held = await loadTicket(f);
  assert.equal(held.execution, mid?.execution);
  assert.equal(held.state, 'held');
  assert.equal(f.comments().length, 1);
  assert.equal(endsOf(f, held.execution).length, 1);
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');

  f.gh.labels.delete(NEEDS_HUMAN);
  const third = await run.runTarget(f.options);
  assert.equal(ticketResult(third).outcome, 'skipped', 'a held Execution with Visits needs its row deleted');
  assert.equal(f.harness.calls.length, 2, 'no agent call beyond the seeded 2');
});

test('a landed hold comment with a lost response is not posted twice', async (t) => {
  const { f } = await dirtyTicket(t, false);
  failComment(f, { lost: true });
  // The retry looks for the comment by its marker first, so the hold lands within the Run.
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the marker found it, so it was not posted again');
  assert.equal(f.gh.calls.filter((c) => golden.isCommentPost(c.args)).length, 1);
  const final = await loadTicket(f);
  const comment = final.log.find((e) => e.step === 'intent' && e.action === 'comment');
  assert.deepEqual(final.log.filter((e) => e.marker === comment.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.equal(final.log.find((e) => e.marker === comment.marker && e.step === 'evidence').evidence.id, f.gh.comments[0].id);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'held');
});

test('an ensureWorktree failure without a record is marked and never retried', async (t) => {
  const f = fixture(t);
  let adds = 0;
  f.options.git = { ...f.options.git, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.match(ticketResult(results).error, /disk full/);
  const rec = await loadTicket(f);
  assert.equal(rec?.state, 'fault', 'the fault is marked on a record created for it');
  assert.equal(rec.branch, BRANCH);
  assert.equal(rec.worktree, f.worktree);
  assert.ok(f.comments().some((b) => b.includes('disk full')), JSON.stringify(f.comments()));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  assert.ok(!f.labelAdds().includes(IN_PROGRESS), 'in-progress is never set');
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.phase} ${e.ordinal}` : e.type)), ['ticket_start', 'fault 1', 'fault 2', 'ticket_end']);
  assert.ok(evs.every((e) => e.execution === rec.execution));
  assert.match(evs.at(-1).error, /disk full/);
  assert.equal(f.harness.calls.length, 0);

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is never retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
  assert.equal(run.runExitCode(second), 2);
});

test('admission holds emit ticket lifecycle events with their Terminal Reason: a record on another branch', async (t) => {
  const f = fixture(t);
  await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'red' },
    configHash: 'x', run: 'seed', worktree: f.worktree, branch: 'ticket/99-other', base: 'main' }));

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  const rec = await loadTicket(f);
  assert.equal(rec?.terminalReason?.decidedBy.hold, 'branch-mismatch');
  assert.equal(rec.state, 'held');
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.vertex} ${e.phase} ${e.ordinal}` : e.type)),
    ['ticket_start', 'needs-human hold 1', 'needs-human hold 2', 'ticket_end']);
  assert.ok(evs.every((e) => e.execution === rec.execution && e.run === lastRun(f)), 'one Execution and Run throughout');
  assert.equal(evs.at(-1).outcome, 'needs-human');
  assert.deepEqual(evs.at(-1).reason, rec.terminalReason);
  assert.doesNotMatch(rec.terminalReason.text, /re-run|DELETE FROM/, 'the Terminal Reason is one sentence; the advice is in the comment');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
});
